/* TierMux — webview controller (vanilla JS). */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (sel, root) => (root || document).querySelector(sel);

  let state = { catalog: [], fallback: [], platforms: [] };
  let pendingAttachments = [];
  let busy = false;
  // The session currently shown. Messages for other (background) sessions are ignored —
  // their state lives on the host, which re-sends a session's transcript + live status when
  // we switch to it. This is what keeps several agents running at once without their threads
  // bleeding together in this single webview.
  let viewedSessionId = null;
  let sessionList = [];
  const targets = new Map(); // requestId -> { el, body, tools }
  const userTargets = new Map(); // requestId -> user message element (for the restore bar)
  const startTimes = new Map(); // requestId -> send time, for "Worked for Ns"
  const statusTimers = new Map(); // requestId -> interval id, drives the live "Thinking… Ns" header
  // The .turn wrapping the current user command + its reply. Bounding each turn is what
  // lets the sticky command pin only while you scroll its own answer (see .turn in CSS).
  let currentTurn = null;

  // ---------- markdown ----------
  // Configure marked ONCE: render embedded raw HTML as escaped TEXT instead of live DOM, so a
  // chat message containing an HTML form/snippet shows as readable, searchable source — and
  // can't inject widgets or handlers into the webview. Only raw `html` tokens are escaped;
  // markdown-generated elements (incl. GFM task-list checkboxes) render normally.
  let markedReady = false;
  function configureMarked() {
    if (markedReady || !window.marked) return;
    markedReady = true;
    try {
      window.marked.use({
        renderer: {
          html(token) {
            const raw = typeof token === 'string' ? token : (token && token.raw != null ? token.raw : (token && token.text) || '');
            return escapeHtml(raw);
          },
        },
      });
    } catch (_) {}
  }

  function renderMarkdown(md) {
    try {
      if (window.marked) {
        configureMarked();
        const html = window.marked.parse(md, { breaks: true, gfm: true });
        const div = document.createElement('div');
        div.innerHTML = html;
        div.querySelectorAll('script').forEach((s) => s.remove());
        // Neutralize script-y URLs that markdown links/images can still carry (marked v12
        // does not sanitize URLs) — same render sink, cheap defense-in-depth.
        div.querySelectorAll('a[href]').forEach((a) => { if (/^\s*(javascript|data|vbscript):/i.test(a.getAttribute('href') || '')) a.removeAttribute('href'); });
        if (window.hljs) div.querySelectorAll('pre code').forEach((b) => { try { window.hljs.highlightElement(b); } catch (_) {} });
        return div;
      }
    } catch (_) {}
    const pre = document.createElement('div');
    pre.textContent = md;
    return pre;
  }

  function typeInto(container, fullText) {
    container.innerHTML = '';
    const total = fullText.length;
    if (total < 40) { container.appendChild(renderMarkdown(fullText)); scrollDown(); return; }
    let i = 0;
    const step = Math.max(2, Math.floor(total / 160));
    const timer = setInterval(() => {
      i += step;
      if (i >= total) { clearInterval(timer); container.innerHTML = ''; container.appendChild(renderMarkdown(fullText)); scrollDown(); return; }
      container.innerHTML = '';
      container.appendChild(renderMarkdown(fullText.slice(0, i)));
      scrollDown();
    }, 16);
  }

  // ---------- icons (inline SVG, offline) ----------
  const ICON = {
    attach: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    selection: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="12" height="12"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    revert: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11"/><path d="M18 21H5V10l5-7a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 18 21z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3"/><path d="M6 3h13v11l-5 7a2 2 0 0 1-2-2v-4H6a2 2 0 0 1-2-2.4l1.4-7A2 2 0 0 1 6 3z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
    zap: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  };
  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    let h = d.getHours(); const m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${m < 10 ? '0' + m : m} ${ap}`;
  }
  // Compact token count: 4325 -> "4.3k", 67 -> "67", 1200000 -> "1.2M".
  function fmtTokens(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  // Friendly per-message usage, e.g. "4.3k in · 67 out".
  function fmtUsage(u) {
    if (!u) return '';
    return `${fmtTokens(u.promptTokens)} in · ${fmtTokens(u.completionTokens)} out`;
  }

  // Dollar formatter for the "est. $ saved" line. Two decimals by default;
  // sub-cent amounts show as "$0.00" so the line never reads like a precise bill.
  function fmtUsd(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '$0.00';
    if (n < 0.01) return '<$0.01';
    if (n < 1) return '$' + n.toFixed(2);
    if (n < 100) return '$' + n.toFixed(2);
    return '$' + n.toFixed(1);
  }

  // ---------- layout ----------
  const app = $('#app');
  app.innerHTML = `
    <div class="chat-layout" id="chat-layout">
      <div class="history-dropdown hidden" id="history-dropdown">
        <div class="history-dropdown-header">
          <input type="text" id="history-search" class="history-search" placeholder="Search sessions…" autocomplete="off" />
        </div>
        <div class="history-list" id="history-list"></div>
      </div>
      <div class="chat-header">
        <input id="chat-title" class="chat-title" type="text" placeholder="New chat" autocomplete="off" spellcheck="false" />
      </div>
      <div class="thread" id="thread"></div>
      <div class="settings" id="settings"></div>
    <div class="composer" id="composer">
      <div class="index-status hidden" id="index-status"></div>
      <div class="changed-bar hidden" id="changed-bar"></div>
      <div class="chips" id="chips"></div>
      <div class="input-wrap">
        <div id="ac-pop" class="ac-pop hidden"></div>
        <textarea id="input" placeholder="Type a message…  (@ for files, / for commands)" title="Enter to send · Shift+Enter for newline · @file · /fix /tests /commit"></textarea>
        <div class="toolbar">
          <div class="tgroup">
            <div class="mode-picker">
              <button type="button" id="mode-btn" class="pill" title="Mode — how the assistant handles your message"><span class="mode-label">Auto</span></button>
              <div id="mode-pop" class="mode-pop hidden"></div>
            </div>
            <div class="model-picker">
              <button type="button" id="model-btn" class="pill" title="Model"><span class="mb-label">Auto</span></button>
              <div id="model-pop" class="model-pop hidden">
                <input id="model-search" type="text" placeholder="Search models…" />
                <div id="model-list"></div>
              </div>
            </div>
            <span class="select-wrap">
              <select id="reasoning" title="Reasoning effort" class="pill" disabled>
                <option value="off">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Very High</option>
              </select>
            </span>
            <button type="button" id="auto-btn" class="pill toggle-pill" aria-pressed="false" title="Auto-approve — run commands and apply edits without asking, for an uninterrupted flow. Dangerous commands (rm -rf, force push, sudo…) still ask. Off = review each step." data-tooltip="Auto-approve — run commands and edit files without asking first. Dangerous operations still confirm. Toggle on for an uninterrupted flow.">${ICON.zap}</button>
          </div>
          <div class="tgroup right">
            <button class="icon-btn" id="btn-selection" title="Add editor selection as context" data-tooltip="Add editor selection as context">${ICON.selection}</button>
            <button class="icon-btn" id="btn-attach" title="Attach file or image" data-tooltip="Attach file or image">${ICON.attach}</button>
            <button class="send-btn" id="btn-send" title="Send (Enter)">${ICON.send}</button>
          </div>
        </div>
      </div>
      <div class="footer" id="footer">No tokens used yet.</div>
    </div>
    </div>`;

  const thread = $('#thread');
  const railEl = null; // replaced by history dropdown
  const historyDropdown = $('#history-dropdown');
  const historySearch = $('#history-search');
  const historyList = $('#history-list');
  const settingsEl = $('#settings');
  const composer = $('#composer');
  const input = $('#input');
  const reasoningSel = $('#reasoning');
  const chipsEl = $('#chips');
  const modelBtn = $('#model-btn');
  const modelBtnLabel = $('.mb-label', modelBtn);
  const modelPop = $('#model-pop');
  const modelSearch = $('#model-search');
  const modelList = $('#model-list');
  let currentModel = 'auto';

  // Mode picker (custom dropdown: button shows the short name, list shows name + description).
  const MODES = [
    { value: 'chat', label: 'Ask', desc: 'Read-only. Answers questions and explains code — never edits files or runs commands.' },
    { value: 'plan', label: 'Plan', desc: 'Researches the code, proposes a plan (professional or team discussion), then edits only after you approve.' },
    { value: 'agent', label: 'Agent', desc: 'Full agent — reads, edits files, runs commands, and tracks a live task list.' },
  ];
  let currentMode = 'chat';
  const modeBtn = $('#mode-btn');
  const modeBtnLabel = $('.mode-label', modeBtn);
  const modePop = $('#mode-pop');
  function buildModePicker() {
    modePop.innerHTML = '';
    MODES.forEach((m) => {
      const item = document.createElement('div');
      item.className = 'mode-item' + (m.value === currentMode ? ' selected' : '');
      const lbl = document.createElement('div'); lbl.className = 'mode-item-label'; lbl.textContent = m.label;
      const desc = document.createElement('div'); desc.className = 'mode-item-desc'; desc.textContent = m.desc;
      item.appendChild(lbl); item.appendChild(desc);
      item.addEventListener('click', () => setMode(m.value));
      modePop.appendChild(item);
    });
  }
  function setMode(value) {
    const m = MODES.find((x) => x.value === value) || MODES[0];
    currentMode = m.value;
    modeBtnLabel.textContent = m.label;
    modeBtn.title = m.desc;
    closeModePop();
  }
  function openModePop() { buildModePicker(); modePop.classList.remove('hidden'); }
  function closeModePop() { modePop.classList.add('hidden'); }
  modeBtn.addEventListener('click', (e) => { e.stopPropagation(); modePop.classList.contains('hidden') ? openModePop() : closeModePop(); });

  // Auto-approve toggle: when on, the agent runs commands and applies edits without a
  // prompt (dangerous commands still confirm). State is owned by the extension and
  // restored from the config message; this just reflects and flips it.
  const autoBtn = $('#auto-btn');
  let autoApprove = false;
  function renderAutoApprove() {
    autoBtn.classList.toggle('on', autoApprove);
    autoBtn.setAttribute('aria-pressed', String(autoApprove));
  }
  autoBtn.addEventListener('click', () => {
    autoApprove = !autoApprove;
    renderAutoApprove();
    vscode.postMessage({ type: 'setAutoApprove', enabled: autoApprove });
  });

  // Chat header: brand + editable session title (rename inline, Enter to save).
  const titleInput = $('#chat-title');
  let lastTitle = '';
  function commitTitle() {
    const v = (titleInput.value || '').trim();
    if (v && v !== lastTitle) { lastTitle = v; vscode.postMessage({ type: 'renameSession', title: v }); }
    else { titleInput.value = lastTitle; }
    titleInput.blur();
  }
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
    else if (e.key === 'Escape') { titleInput.value = lastTitle; titleInput.blur(); }
  });
  titleInput.addEventListener('blur', commitTitle);

  const PLATFORM_NAMES = {
    google: 'Google', groq: 'Groq', cerebras: 'Cerebras', nvidia: 'NVIDIA', mistral: 'Mistral',
    openrouter: 'OpenRouter', github: 'GitHub Models', cohere: 'Cohere', cloudflare: 'Cloudflare',
    zhipu: 'Zhipu', ollama: 'Ollama', kilo: 'Kilo', pollinations: 'Pollinations', llm7: 'LLM7',
    huggingface: 'HuggingFace', opencode: 'OpenCode', ovh: 'OVH', agnes: 'Agnes', custom: 'Custom',
  };

  // Helper to resolve platform display name (including custom endpoints)
  function platformDisplayName(platform, modelId) {
    if (platform === 'custom' && modelId) {
      const epId = modelId.split('::')[0];
      const ep = (state.customEndpoints || []).find((e) => e.id === epId);
      return ep ? ep.name : 'Custom';
    }
    return PLATFORM_NAMES[platform] || platform;
  }

  const acPop = $('#ac-pop');
  const SLASH_COMMANDS = [
    { name: 'explain', detail: 'Explain the referenced code' },
    { name: 'fix', detail: 'Find and fix problems' },
    { name: 'tests', detail: 'Write unit tests' },
    { name: 'doc', detail: 'Add documentation/comments' },
    { name: 'commit', detail: 'Generate a commit message from staged changes' },
  ];
  // Autocomplete state.
  let acMode = null;       // 'slash' | 'mention' | null
  let acStart = -1;        // index of the trigger char in the textarea
  let acItems = [];        // current suggestion list
  let acIndex = 0;         // highlighted index
  let acQueryId = 0;       // latest mention query id (to ignore stale results)
  let acDebounce;

  function scrollDown() { thread.scrollTop = thread.scrollHeight; }

  // Transient toast (e.g. "Copied", "Liked") shown right at the clicked element so the
  // feedback appears where the user acted, not at the bottom of the panel.
  function showToast(text, anchor) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
    document.body.appendChild(t);
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    if (r) {
      const tw = t.offsetWidth, th = t.offsetHeight;
      let left = Math.max(6, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 6));
      let top = r.top - th - 6;            // prefer just above the button
      if (top < 6) top = r.bottom + 6;     // flip below if there's no room above
      t.style.left = left + 'px'; t.style.top = top + 'px';
    } else {
      t.style.left = '50%'; t.style.bottom = '64px'; t.style.transform = 'translateX(-50%)';
    }
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 200); }, 1400);
  }

  // ---------- session history dropdown ----------
  const STATUS_DOT = { idle: '●', queued: '⏳', running: '⟳', needsApproval: '!', finished: '✓' };
  const STATUS_TITLE = {
    idle: 'Idle', queued: 'Queued', running: 'Running',
    needsApproval: 'Needs your approval', finished: 'Finished',
  };

  function fmtSessionDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const isToday = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const date = isToday ? 'Today' : `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const h = d.getHours(), m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${date} ${h12}:${pad(m)} ${ampm}`;
  }

  let historyOpen = false;
  let historyQuery = '';

  function toggleHistory(force) {
    historyOpen = typeof force === 'boolean' ? force : !historyOpen;
    if (historyOpen) {
      historyDropdown.classList.remove('hidden');
      historySearch.value = '';
      historyQuery = '';
      renderTabs();
      historySearch.focus();
    } else {
      historyDropdown.classList.add('hidden');
    }
  }

  historySearch.addEventListener('input', () => {
    historyQuery = historySearch.value.toLowerCase();
    renderTabs();
  });
  historySearch.addEventListener('click', (e) => e.stopPropagation());
  historyDropdown.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => { if (historyOpen && !historyDropdown.contains(e.target)) toggleHistory(false); });

  function renderTabs() {
    if (!historyOpen) return;
    historyList.innerHTML = '';
    const filtered = historyQuery
      ? sessionList.filter(s => (s.title || '').toLowerCase().includes(historyQuery))
      : sessionList;
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = historyQuery ? 'No matching sessions' : 'No sessions yet';
      historyList.appendChild(empty);
      return;
    }
    filtered.forEach((s) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'history-item' + (s.id === viewedSessionId ? ' active' : '') + (' status-' + (s.status || 'idle'));
      const left = document.createElement('div');
      left.className = 'history-item-left';
      const dot = document.createElement('span');
      dot.className = 'history-dot';
      dot.textContent = STATUS_DOT[s.status || 'idle'] || '●';
      dot.title = STATUS_TITLE[s.status || 'idle'] || '';
      const lbl = document.createElement('span');
      lbl.className = 'history-label';
      lbl.textContent = s.title || 'New session';
      left.appendChild(dot);
      left.appendChild(lbl);
      const ts = document.createElement('span');
      ts.className = 'history-ts';
      ts.textContent = fmtSessionDate(s.updatedAt || s.createdAt);
      item.appendChild(left);
      item.appendChild(ts);
      item.addEventListener('click', () => {
        if (s.id !== viewedSessionId) vscode.postMessage({ type: 'switchSession', sessionId: s.id });
        toggleHistory(false);
      });
      historyList.appendChild(item);
    });
  }

  // ---------- empty / welcome state ----------
  function clearEmpty() { const e = thread.querySelector('.empty'); if (e) e.remove(); }
  function renderEmpty() {
    if (thread.querySelector('.msg')) return;
    clearEmpty();
    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = `
      <div class="empty-logo">⚡</div>
      <div class="empty-title">${window.__PRODUCT_NAME__ || 'TierMux'}</div>
      <div class="empty-sub">Your AI coding assistant — ask it to build features, fix bugs, or explain your codebase. Routed across ~18 free providers with automatic failover.</div>
      <div class="empty-sub muted">Open ⚙ in the title bar to add an API key.</div>`;
    thread.appendChild(el);
  }

  // ---------- send ----------
  function newId() { return 'r' + Date.now() + Math.random().toString(36).slice(2, 6); }

  function iconBtn(icon, title, onClick) {
    const b = document.createElement('button');
    b.className = 'm-ic'; b.title = title; b.innerHTML = icon;
    b.addEventListener('click', onClick);
    return b;
  }
  function copyBtn(el) {
    const b = iconBtn(ICON.copy, 'Copy message', () => {
      vscode.postMessage({ type: 'copyText', text: el._copyText || '' });
      b.classList.add('ok');
      setTimeout(() => b.classList.remove('ok'), 1000);
      showToast('Copied', b);
    });
    return b;
  }
  function feedbackBtns(requestId) {
    const frag = document.createDocumentFragment();
    const set = (which) => {
      const el = which === 'up' ? up : down, other = which === 'up' ? down : up;
      const now = el.classList.contains('on') ? 'none' : which; // second click un-votes
      el.classList.toggle('on', now === which); other.classList.remove('on');
      if (requestId) vscode.postMessage({ type: 'vote', requestId, vote: now });
      showToast(now === 'up' ? '👍 Liked — prefer this model' : now === 'down' ? '👎 Disliked — avoid this model' : 'Feedback removed', el);
    };
    const up = iconBtn(ICON.up, 'Good response — prefer this model for similar tasks', () => set('up'));
    const down = iconBtn(ICON.down, 'Bad response — avoid this model for similar tasks', () => set('down'));
    frag.appendChild(up); frag.appendChild(down);
    return frag;
  }

  function addUserBubble(text, requestId, ts, attachments) {
    clearEmpty();
    const el = document.createElement('div');
    el.className = 'msg user';
    el._copyText = text;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const body = document.createElement('div'); body.className = 'msg-text';
    const textBody = document.createElement('div'); textBody.className = 'msg-text-body';
    textBody.appendChild(renderMarkdown(text || ''));
    body.appendChild(textBody);
    if (attachments && attachments.length) {
      const atts = document.createElement('div'); atts.className = 'msg-attachments';
      for (const a of attachments) {
        if (a.kind === 'image' && a.dataUrl) {
          const img = document.createElement('img');
          img.className = 'msg-att-img';
          img.src = a.dataUrl;
          img.alt = a.name || '';
          img.title = a.name || '';
          atts.appendChild(img);
        } else {
          const span = document.createElement('span');
          span.className = 'msg-att-chip';
          span.textContent = `${iconForKind(a.kind)} ${a.name || ''}`;
          atts.appendChild(span);
        }
      }
      body.appendChild(atts);
    }
    const meta = document.createElement('div'); meta.className = 'msg-meta';
    const time = document.createElement('span'); time.className = 'ts'; time.textContent = fmtTime(ts);
    meta.appendChild(time);
    meta.appendChild(copyBtn(el));
    if (requestId) meta.appendChild(iconBtn(ICON.revert, 'Revert to here (restore workspace + chat to before this message)', () => vscode.postMessage({ type: 'revertTo', requestId })));
    bubble.appendChild(body); bubble.appendChild(meta);
    el.appendChild(bubble);
    // Start a new turn group: the command plus whatever replies/follow below it.
    currentTurn = document.createElement('div');
    currentTurn.className = 'turn';
    currentTurn.appendChild(el);
    thread.appendChild(currentTurn);
    clampUserText(body, textBody); // collapse long questions with a See more / See less toggle
    if (requestId) userTargets.set(requestId, el);
    if (requestId) startTimes.set(requestId, ts || Date.now());
    scrollDown();
  }

  // Collapse a long user question to a few lines, with a See more / See less toggle so
  // it doesn't dominate the viewport while pinned. Must run after the element is in the DOM.
  function clampUserText(body, textBody) {
    textBody.classList.add('clamped');
    if (textBody.scrollHeight <= textBody.clientHeight + 4) { textBody.classList.remove('clamped'); return; }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'see-toggle';
    toggle.textContent = 'See more';
    toggle.addEventListener('click', () => {
      const clamped = textBody.classList.toggle('clamped');
      toggle.textContent = clamped ? 'See more' : 'See less';
    });
    body.appendChild(toggle); // sits directly under the text, inside the left column
  }

  function assistantFooter(el, model, ts, requestId) {
    const foot = document.createElement('div'); foot.className = 'msg-foot';
    const left = document.createElement('span'); left.className = 'foot-left';
    left.textContent = (model ? model + '  ·  ' : '') + fmtTime(ts);
    const acts = document.createElement('span'); acts.className = 'foot-acts';
    acts.appendChild(copyBtn(el));
    acts.appendChild(feedbackBtns(requestId));
    foot.appendChild(left); foot.appendChild(acts);
    return foot;
  }

  // Build a single tool-step card from a persisted step (mirrors upsertTool, but static).
  // A visible "thinking" block — the model's per-step reasoning, shown before that step's
  // tool runs (think → act, like Claude Code / Kilo Code). Rides the same step list as tool
  // cards (step.name === 'reasoning', text in step.detail) so it persists across re-renders.
  function buildReasoningBlock(text, tc) {
    const block = document.createElement('div');
    block.className = 'think-block';
    block.dataset.live = '1';
    if (tc) block.dataset.tc = tc;
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.innerHTML = `<span class="think-ic">◌</span><span class="think-cap">Thinking</span>`;
    const body = document.createElement('div');
    body.className = 'think-body';
    body.appendChild(renderMarkdown(text || ''));
    det.appendChild(sum);
    det.appendChild(body);
    block.appendChild(det);
    return block;
  }

  function buildToolCard(step) {
    if (step.name === 'reasoning') {
      const block = buildReasoningBlock(step.detail || '', step.toolCallId);
      // Static re-render: reasoning is done, show as collapsed "Thought"
      block.dataset.live = '0';
      const cap = block.querySelector('.think-cap'); if (cap) cap.textContent = 'Thought';
      const ic  = block.querySelector('.think-ic');  if (ic)  ic.textContent  = '◉';
      return block;
    }
    const state = step.state || 'done';
    const card = document.createElement('div');
    card.className = 'tool-card state-' + state;
    if (step.toolCallId) card.dataset.tc = step.toolCallId;
    card.innerHTML = `<div class="tool-head"><span class="tool-ic"></span><span class="tool-title"></span><span class="tool-hint"></span><span class="state"></span></div><details class="tool-more hidden"><summary>output</summary><pre></pre></details>`;
    const { icon, title, hint } = toolLabel(step.name, step.args, step.detail);
    card.querySelector('.tool-ic').textContent = icon;
    card.querySelector('.tool-title').textContent = title;
    const hintEl = card.querySelector('.tool-hint');
    if (hintEl) hintEl.textContent = hint || '';
    const st = card.querySelector('.state');
    st.className = 'state ' + state;
    const icon2 = STATE_ICON[state];
    st.textContent = (icon2 === null || icon2 === undefined) ? '' : icon2;
    const argStr = (step.args && typeof step.args === 'object') ? JSON.stringify(step.args, null, 2) : String(step.args || '');
    const parts = [];
    if (argStr && argStr !== '{}') parts.push(argStr);
    if (step.detail) parts.push(step.detail);
    const body = parts.join('\n\n');
    const more = card.querySelector('.tool-more');
    if (body.trim()) { more.querySelector('pre').textContent = body; more.classList.remove('hidden'); }
    return card;
  }

  // Rebuild a finished assistant message from the transcript. Mirrors the live render so a
  // re-render (e.g. after "Revert to here" or a session switch) keeps the "Reasoning" and
  // "Worked for Ns" disclosures plus the model/usage/secs footer — instead of dropping them.
  function renderAssistantStatic(text, model, ts, secs, details) {
    clearEmpty();
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el._copyText = text;
    details = details || {};
    const steps = (details.steps || []).filter(Boolean);
    // Inline 🧠 Thinking blocks (reasoning steps) already render the reasoning, so only fall
    // back to a 💭 Reasoning disclosure when the steps don't carry it — never show it twice.
    const hasReasoning = !!details.reasoning && !steps.some((s) => s.name === 'reasoning');
    // Live runs nest reasoning inside the "Worked for Ns" disclosure (it lives in t.tools),
    // and that disclosure is dropped only when it holds neither reasoning nor any step.
    if (hasReasoning || steps.length) {
      const work = document.createElement('details'); work.className = 'work';
      const sum = document.createElement('summary');
      sum.innerHTML = `<span class="work-chevron">${ICON.chevron}</span><span class="work-label">Worked${secs != null ? ` for ${secs}s` : ''}</span>`;
      work.appendChild(sum);
      const tools = document.createElement('div'); tools.className = 'tools';
      if (hasReasoning) {
        const det = document.createElement('details'); det.className = 'reasoning';
        det.innerHTML = `<summary>Reasoning</summary>`;
        det.appendChild(renderMarkdown(details.reasoning));
        tools.appendChild(det);
      }
      steps.forEach((step) => tools.appendChild(buildToolCard(step)));
      work.appendChild(tools);
      el.appendChild(work);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.appendChild(renderMarkdown(text));
    el.appendChild(bubble);
    let footStr = (model || '');
    if (details.usage) footStr += `  ·  ${fmtUsage(details.usage)}`;
    if (secs != null) footStr += `  ·  ${secs}s`;
    el.appendChild(assistantFooter(el, footStr, ts));
    (currentTurn || thread).appendChild(el);
  }

  function ensureTarget(requestId, platform, model) {
    let t = targets.get(requestId);
    if (t) return t;
    clearEmpty();
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el._copyText = '';
    // "Worked for Ns" collapsible holding the agent's steps + reasoning.
    const work = document.createElement('details'); work.className = 'work pending'; work.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = `<span class="work-chevron">${ICON.chevron}</span><span class="work-label">Working…</span>`;
    const tools = document.createElement('div'); tools.className = 'tools';
    work.appendChild(sum); work.appendChild(tools);
    const statusEl = document.createElement('div');
    statusEl.className = 'agent-status';
    statusEl.innerHTML = `<span class="agent-spinner"></span><span class="agent-label">Working…</span><span class="agent-elapsed"></span>`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    el.appendChild(statusEl);
    el.appendChild(work);
    el.appendChild(bubble);
    (currentTurn || thread).appendChild(el);
    const modelStr = model ? `${platform || ''}/${model}` : '';
    t = { el, body: bubble, tools, work, workLabel: sum.querySelector('.work-label'), statusEl, statusLabel: statusEl.querySelector('.agent-label'), statusElapsed: statusEl.querySelector('.agent-elapsed'), model: modelStr, requestId };
    targets.set(requestId, t);
    scrollDown();
    return t;
  }

  // ---------- live "agent is working" status header ----------
  // Keep the last two segments of a path so absolute workspace paths stay tidy.
  function shortPath(p) {
    const s = String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
    const parts = s.split('/').filter(Boolean);
    return parts.length <= 2 ? parts.join('/') : parts.slice(-2).join('/');
  }
  // Present-tense "what the agent is doing right now" for the live status line.
  function toolVerb(name, args) {
    if (name === 'step' && args && typeof args === 'object') {
      return args.of ? `Step ${args.step}/${args.of}` : 'Working on a step';
    }
    const path = shortPath(firstArg(args));
    const obj = args && typeof args === 'object' ? args : {};
    const query = String(obj.query || obj.pattern || obj.term || '').trim();
    const cmd = String(obj.command || obj.cmd || '').trim();
    switch (name) {
      case 'readFile':        return path ? `Reading ${path}` : 'Reading a file';
      case 'listDir':         return path ? `Listing ${path}` : 'Listing files';
      case 'repoMap':         return 'Mapping the repository';
      case 'searchWorkspace': return query ? `Searching for “${query}”` : 'Searching the workspace';
      case 'codebaseSearch':  return query ? `Semantic search for “${query}”` : 'Running semantic search';
      case 'getDiagnostics':  return 'Checking diagnostics';
      case 'runCommand': {
        const c = cmd.split(/\s+/).slice(0, 6).join(' ');
        return c ? `Running: ${c}` : 'Running a command';
      }
      case 'writeFile':
      case 'createFile':      return path ? `Writing ${path}` : 'Writing a file';
      case 'editFile':        return path ? `Editing ${path}` : 'Editing a file';
      case 'deleteFile':      return path ? `Deleting ${path}` : 'Deleting a file';
      default:
        if (name && name.indexOf('mcp__') === 0) {
          const seg = name.split('__'); return `Calling ${seg[1] || 'MCP tool'}`;
        }
        return name ? (name.charAt(0).toUpperCase() + name.slice(1) + '…') : 'Working…';
    }
  }
  function startStatusTimer(requestId) {
    if (statusTimers.has(requestId)) return; // already ticking
    const start = startTimes.get(requestId) || Date.now();
    const tgt = targets.get(requestId);
    if (tgt) tgt.startedAt = start; // remember the epoch so finalizeWork can compute "Worked for Ns"
    const update = () => {
      const t = targets.get(requestId);
      if (!t || !t.statusElapsed) return;
      t.statusElapsed.textContent = Math.max(0, Math.round((Date.now() - start) / 1000)) + 's';
    };
    update();
    statusTimers.set(requestId, setInterval(update, 500));
  }
  function stopStatusTimer(requestId, hide) {
    const id = statusTimers.get(requestId);
    if (id) { clearInterval(id); statusTimers.delete(requestId); }
    if (hide) {
      const t = targets.get(requestId);
      if (t && t.statusEl) t.statusEl.classList.add('hidden');
    }
  }
  // Collapse the live status into the final "Worked for Ns" disclosure (or drop it
  // when the agent did no steps). Reveals the summary the .pending class had hidden.
  function finalizeWork(requestId) {
    const t = targets.get(requestId);
    if (!t || !t.work) return;
    if (t.tools.children.length === 0) {
      t.work.remove();
    } else {
      const started = t.startedAt ?? startTimes.get(requestId);
      const secs = started ? Math.max(1, Math.round((Date.now() - started) / 1000)) : null;
      if (t.workLabel) t.workLabel.textContent = secs != null ? `Worked for ${secs}s` : 'Worked';
      t.work.classList.remove('pending');
      t.work.open = false;
    }
  }

  function send() {
    if (busy) { vscode.postMessage({ type: 'cancel', requestId: 'current', sessionId: viewedSessionId }); return; }
    const text = input.value.trim();
    if (!text && pendingAttachments.length === 0) return;
    const requestId = newId();
    // Send a preview of pending visual attachments in the user bubble so the user
    // sees what they attached (data URLs only — the host keeps the canonical copy).
    const previews = pendingAttachments
      .filter((a) => a.kind === 'image' && a.dataUrl)
      .map((a) => ({ kind: 'image', name: a.name, dataUrl: a.dataUrl }));
    addUserBubble(text, requestId, Date.now(), pendingAttachments.map((a) => ({ kind: a.kind, name: a.name, dataUrl: a.dataUrl })));
    vscode.postMessage({
      type: 'sendMessage', requestId, text,
      mode: currentMode, model: currentModel, reasoningEffort: reasoningSel.value,
      attachments: pendingAttachments,
      attachmentKinds: pendingAttachments.map((a) => a.kind),
    });
    input.value = '';
    autoGrow(); // reset the textarea back to one line after sending (don't leave it stuck tall)
    pendingAttachments = [];
    renderChips();
  }

  $('#btn-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (!acPop.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAc(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => { autoGrow(); updateAutocomplete(); });
  input.addEventListener('click', updateAutocomplete);
  input.addEventListener('blur', () => setTimeout(closeAc, 120));
  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }

  // ---------- per-session composer state (draft / model / mode / reasoning / attachments) ----------
  // The thread is already session-isolated; this stashes the composer for the session we're
  // leaving and restores it for the one we're entering, so each tab keeps its own in-progress
  // message and settings — like separate chat tabs.
  const composerState = new Map(); // sessionId -> { draft, model, mode, reasoning, attachments }
  function saveComposer(id) {
    if (!id) return;
    composerState.set(id, {
      draft: input.value,
      model: currentModel,
      mode: currentMode,
      reasoning: reasoningSel.value,
      attachments: pendingAttachments.slice(),
    });
  }
  function loadComposer(id) {
    const c = composerState.get(id);
    input.value = c ? c.draft : '';
    setMode(c ? c.mode : 'chat');
    currentModel = c ? c.model : 'auto';
    rebuildModelPicker(); // syncs the model button label + reasoning availability to currentModel
    reasoningSel.value = c ? c.reasoning : 'medium';
    updateReasoningAvailability();
    pendingAttachments = c && c.attachments ? c.attachments.slice() : [];
    renderChips();
    autoGrow();
  }
  // Persist the draft as the user types, so a background switch never loses it.
  input.addEventListener('input', () => { if (viewedSessionId) saveComposer(viewedSessionId); });

  $('#btn-attach').addEventListener('click', () => vscode.postMessage({ type: 'attachFromWorkspace' }));
  $('#btn-selection').addEventListener('click', () => vscode.postMessage({ type: 'addSelection' }));
  // Close transient popups when the view loses focus or is hidden (e.g. switching tabs).
  window.addEventListener('blur', () => { closeModelPop(); closeModePop(); closeAc(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { closeModelPop(); closeModePop(); closeAc(); } });

  // Custom model dropdown (scrollable + searchable).
  modelBtn.addEventListener('click', (e) => { e.stopPropagation(); modelPop.classList.contains('hidden') ? openModelPop() : closeModelPop(); });
  modelSearch.addEventListener('input', filterModels);
  modelSearch.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelPop(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.model-picker')) closeModelPop(); if (!e.target.closest('.mode-picker')) closeModePop(); });

  function openModelPop() { modelPop.classList.remove('hidden'); modelSearch.value = ''; filterModels(); modelSearch.focus(); }
  function closeModelPop() { modelPop.classList.add('hidden'); }
  function setModel(value, label) {
    currentModel = value;
    modelBtnLabel.textContent = label || value;
    modelBtn.title = label || value;
    modelList.querySelectorAll('.model-item').forEach((it) => it.classList.toggle('selected', it.dataset.value === value));
    closeModelPop();
    updateReasoningAvailability();
  }
  function filterModels() {
    const q = modelSearch.value.trim().toLowerCase();
    modelList.querySelectorAll('.model-item').forEach((it) => { it.style.display = !q || it.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    modelList.querySelectorAll('.model-group').forEach((h) => { h.style.display = q ? 'none' : ''; });
  }

  // Image + PDF paste: clipboard data carries images, but not PDFs. We still keep
  // the handler wide so any `image/*` paste (screenshots, snips) just works.
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (!file) continue;
        e.preventDefault();
        addImageAttachmentFromFile(file, 'paste');
      }
    }
  });

  // Drag-and-drop onto the composer: any file (image, PDF, doc) goes to the
  // workspace picker path? No — the file is already in the user's hand, just
  // read it and attach it directly. We only need the host for PDF/DOCX text
  // extraction (which the workspace picker triggers); for images we can use
  // the data URL straight from the dropped file.
  ['dragenter', 'dragover'].forEach((ev) =>
    composer.addEventListener(ev, (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); composer.classList.add('drag'); } })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    composer.addEventListener(ev, (e) => { e.preventDefault(); composer.classList.remove('drag'); })
  );
  composer.addEventListener('drop', (e) => {
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) addAttachmentFromFile(f, 'drop');
  });

  /** Add a dropped or pasted file as an attachment. Images are added in-process
   *  (data URL is self-contained). PDFs and DOCX are forwarded to the host,
   *  which extracts text + base64 and posts back an attachmentAdded message. */
  function addAttachmentFromFile(file, source) {
    const mime = (file.type || '').toLowerCase();
    if (mime.startsWith('image/')) {
      addImageAttachmentFromFile(file, source);
      return;
    }
    // Non-image files (PDF, DOCX, etc.): the webview is sandboxed and can't
    // read paths or extract text. We can read the data URL for the host, but
    // for PDFs the canonical path is: save to a temp workspace file → workspace
    // picker path. Simpler: forward the bytes to the host and let it do the
    // extract + attach. The host replies with `attachmentAdded` over the same
    // channel as the workspace picker.
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      vscode.postMessage({ type: 'attachFromDataUrl', name: file.name, mime: file.type || mime, dataUrl, source });
      showComposerStatus(`Extracting ${file.name}…`);
    };
    reader.onerror = () => showComposerStatus(`Could not read ${file.name}`);
    reader.readAsDataURL(file);
  }

  function addImageAttachmentFromFile(file, source) {
    // Downscale very large images client-side to keep the data URL small and
    // the prompt cheap. The host also enforces an 8 MB cap; this avoids hitting it.
    if (file.size > 800_000 && typeof createImageBitmap === 'function') {
      createImageBitmap(file).then((bmp) => {
        const maxSide = 1568;
        const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(bmp, 0, 0, w, h);
        c.toBlob((blob) => {
          if (!blob) { addImageAttachmentFromFileRaw(file, source); return; }
          addImageAttachmentFromFileRaw(new File([blob], file.name || 'image', { type: 'image/jpeg' }), source);
        }, 'image/jpeg', 0.85);
      }).catch(() => addImageAttachmentFromFileRaw(file, source));
      return;
    }
    addImageAttachmentFromFileRaw(file, source);
  }
  function addImageAttachmentFromFileRaw(file, source) {
    const reader = new FileReader();
    reader.onload = () => {
      pendingAttachments.push({ kind: 'image', name: file.name || 'image', mime: file.type, dataUrl: reader.result, source });
      renderChips();
    };
    reader.readAsDataURL(file);
  }
  function showComposerStatus(text) {
    const s = document.getElementById('footer');
    if (s) { const prev = s.textContent; s.textContent = text; setTimeout(() => { if (s.textContent === text) s.textContent = prev; }, 4000); }
  }

  function iconForKind(k) {
    if (k === 'image') return '🖼';
    if (k === 'pdf') return '📕';
    if (k === 'doc') return '📝';
    return '📄';
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    pendingAttachments.forEach((a, idx) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      let preview = '';
      if (a.kind === 'image' && a.dataUrl) preview = `<img class="chip-thumb" src="${a.dataUrl}" alt=""/>`;
      chip.innerHTML = `${preview}<span class="chip-icon">${iconForKind(a.kind)}</span> ${escapeHtml(a.name)} <button title="remove">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => { pendingAttachments.splice(idx, 1); renderChips(); });
      chipsEl.appendChild(chip);
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // Inline modal dialog. VS Code webviews run in a sandboxed iframe without
  // allow-modals, so window.prompt/confirm/alert are silently blocked (prompt
  // returns null, confirm returns false). This renders a real form over the
  // panel instead. Pass `fields` for a form (resolves to string[] or null on
  // cancel); omit fields for a confirm/alert (resolves to true/false).
  function inlineDialog({ title, message, fields, okLabel = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const isForm = Array.isArray(fields) && fields.length > 0;
      const overlay = document.createElement('div');
      overlay.className = 'dlg-overlay';
      const box = document.createElement('div');
      box.className = 'dlg' + (danger ? ' dlg-danger' : '');
      if (title) {
        const h = document.createElement('div'); h.className = 'dlg-title'; h.textContent = title;
        box.appendChild(h);
      }
      if (message) {
        const p = document.createElement('div'); p.className = 'dlg-msg'; p.textContent = message;
        box.appendChild(p);
      }
      const inputs = (fields || []).map((f) => {
        const lab = document.createElement('label'); lab.className = 'dlg-field';
        const sp = document.createElement('span'); sp.textContent = f.label || '';
        const inp = document.createElement('input'); inp.type = f.secret ? 'password' : 'text';
        if (f.placeholder) inp.placeholder = f.placeholder;
        if (f.value != null) inp.value = f.value;
        lab.appendChild(sp); lab.appendChild(inp);
        box.appendChild(lab);
        return inp;
      });
      const actions = document.createElement('div'); actions.className = 'dlg-actions';
      const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = 'Cancel';
      const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = okLabel;
      actions.appendChild(cancel); actions.appendChild(ok);
      box.appendChild(actions);
      overlay.appendChild(box);
      const done = (val) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(isForm ? null : false); }
        else if (e.key === 'Enter' && isForm) { e.preventDefault(); ok.click(); }
      };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(isForm ? null : false); });
      cancel.addEventListener('click', () => done(isForm ? null : false));
      ok.addEventListener('click', () => done(isForm ? inputs.map((i) => i.value) : true));
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      if (inputs.length) setTimeout(() => inputs[0].focus(), 0);
    });
  }

  function updateReasoningAvailability() {
    let supports = false;
    if (currentModel !== 'auto') {
      const [p, ...rest] = currentModel.split('::');
      const m = state.catalog.find((x) => x.platform === p && x.modelId === rest.join('::'));
      supports = !!(m && m.supportsReasoning);
    } else {
      supports = true; // auto may land on a reasoning model
    }
    reasoningSel.disabled = !supports;
    reasoningSel.title = supports ? 'Reasoning effort' : 'This model has no reasoning mode';
    if (!supports) reasoningSel.value = 'off';
  }

  // ---------- model picker ----------
  function addModelItem(value, label, m) {
    const item = document.createElement('div');
    const deprecated = (state.deprecated || []).includes(value);
    item.className = 'model-item' + (value === currentModel ? ' selected' : '') + (deprecated ? ' deprecated' : '');
    item.dataset.value = value;
    const lbl = document.createElement('span');
    lbl.className = 'mi-label';
    lbl.textContent = label;
    item.appendChild(lbl);
    if (deprecated) {
      const tag = document.createElement('span');
      tag.className = 'mi-deprecated';
      tag.textContent = 'unavailable';
      tag.title = 'The provider returned “not found” for this model — it looks deprecated or removed. Auto skips it.';
      item.appendChild(tag);
    }
    const caps = [];
    if (m) { if (m.supportsTools) caps.push('T'); if (m.supportsVision) caps.push('V'); if (m.supportsReasoning) caps.push('R'); }
    if (caps.length) {
      const c = document.createElement('span');
      c.className = 'mi-caps';
      c.innerHTML = caps.map((x) => `<span class="cap" title="${x === 'T' ? 'tools' : x === 'V' ? 'vision' : 'reasoning'}">${x}</span>`).join('');
      item.appendChild(c);
    }
    item.addEventListener('click', () => setModel(value, label));
    modelList.appendChild(item);
  }
  function rebuildModelPicker() {
    modelList.innerHTML = '';
    addModelItem('auto', 'Auto (smart routing)');
    let lastPlatform = null;
    let selectedLabel = null;
    // Only ACTIVE providers appear in the picker — i.e. the user has set a key for the
    // platform (or it's keyless) AND has checked the model. Same set Auto routes over.
    const _disabledProviders = new Set(state.disabledProviders || []);
    const activePlatforms = new Set((state.platforms || []).filter((p) => p.configured && !_disabledProviders.has(p.platform)).map((p) => p.platform));
    const enabled = new Set(
      (state.fallback || [])
        .filter((e) => e.enabled && activePlatforms.has(e.platform))
        .map((e) => `${e.platform}::${e.modelId}`),
    );
    state.catalog.forEach((m) => {
      const value = `${m.platform}::${m.modelId}`;
      if (!enabled.has(value)) return;
      if (m.platform !== lastPlatform) {
        lastPlatform = m.platform;
        const h = document.createElement('div');
        h.className = 'model-group';
        h.textContent = platformDisplayName(m.platform, m.modelId);
        modelList.appendChild(h);
      }
      addModelItem(value, m.displayName, m);
      if (value === currentModel) selectedLabel = m.displayName;
    });
    // Custom endpoints: add enabled models (grouped by endpoint)
    const customModels = (state.fallback || []).filter((e) => e.platform === 'custom' && e.enabled);
    if (customModels.length > 0) {
      const byEndpoint = new Map();
      customModels.forEach((e) => {
        const epId = e.modelId.split('::')[0];
        if (!byEndpoint.has(epId)) byEndpoint.set(epId, []);
        byEndpoint.get(epId).push(e);
      });
      byEndpoint.forEach((models, epId) => {
        const ep = (state.customEndpoints || []).find((e) => e.id === epId);
        const h = document.createElement('div');
        h.className = 'model-group';
        h.textContent = ep ? ep.name : 'Custom';
        modelList.appendChild(h);
        models.forEach((e) => {
          const upstreamId = e.modelId.split('::').slice(1).join('::');
          const value = `custom::${e.modelId}`;
          addModelItem(value, upstreamId, { supportsReasoning: false });
          if (value === currentModel) selectedLabel = upstreamId;
        });
      });
    }
    // If the selected model was unchecked/removed, fall back to Auto.
    if (currentModel !== 'auto' && !enabled.has(currentModel)) currentModel = 'auto';
    // Keep the button label in sync with the current selection.
    if (currentModel === 'auto') { modelBtnLabel.textContent = 'Auto'; modelBtn.title = 'Auto (smart routing)'; }
    else if (selectedLabel) { modelBtnLabel.textContent = selectedLabel; modelBtn.title = selectedLabel; }
    updateReasoningAvailability();
  }

  // ---------- @ / / autocomplete ----------
  function updateAutocomplete() {
    const caret = input.selectionStart;
    const text = input.value.slice(0, caret);

    // Slash command: only when '/' starts the whole input.
    const slashMatch = /^\/(\w*)$/.exec(text);
    if (slashMatch) {
      acMode = 'slash'; acStart = 0;
      const q = slashMatch[1].toLowerCase();
      const items = SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
        .map((c) => ({ label: '/' + c.name, insert: '/' + c.name + ' ', detail: c.detail, kind: 'slash' }));
      items.length ? renderAc(items) : closeAc();
      return;
    }

    // Mention: last '@' at start or after whitespace, no space between it and caret.
    const at = text.lastIndexOf('@');
    if (at !== -1 && (at === 0 || /\s/.test(text[at - 1])) && !/\s/.test(text.slice(at + 1))) {
      acMode = 'mention'; acStart = at;
      const q = text.slice(at + 1);
      const id = ++acQueryId;
      clearTimeout(acDebounce);
      acDebounce = setTimeout(() => vscode.postMessage({ type: 'mentionQuery', queryId: id, query: q }), 150);
      return;
    }
    closeAc();
  }

  function renderAc(items) {
    acItems = items; acIndex = 0;
    acPop.innerHTML = '';
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'ac-item' + (i === 0 ? ' active' : '');
      const icon = it.kind === 'folder' ? '📁' : it.kind === 'symbol' ? '◈' : it.kind === 'slash' ? '/' : '📄';
      row.innerHTML = `<span class="ac-icon">${icon}</span><span class="ac-label"></span><span class="ac-detail muted"></span>`;
      row.querySelector('.ac-label').textContent = it.label;
      row.querySelector('.ac-detail').textContent = it.detail || '';
      row.addEventListener('mousedown', (e) => { e.preventDefault(); acIndex = i; acceptAc(); });
      acPop.appendChild(row);
    });
    acPop.classList.remove('hidden');
  }

  function moveAc(delta) {
    if (!acItems.length) return;
    acIndex = (acIndex + delta + acItems.length) % acItems.length;
    [...acPop.children].forEach((c, i) => c.classList.toggle('active', i === acIndex));
    const active = acPop.children[acIndex];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function acceptAc() {
    const it = acItems[acIndex];
    if (!it) { closeAc(); return; }
    const caret = input.selectionStart;
    const before = input.value.slice(0, acStart);
    const after = input.value.slice(caret);
    const insert = it.kind === 'slash' ? it.insert : '@' + it.insert + ' ';
    input.value = before + insert + after;
    const pos = (before + insert).length;
    input.setSelectionRange(pos, pos);
    closeAc();
    input.focus();
    autoGrow();
  }

  function closeAc() { acPop.classList.add('hidden'); acMode = null; acItems = []; }

  // ---------- tool cards / notices ----------
  // Turn raw tool calls into a human-readable "what the agent is doing" line.
  function firstArg(a) {
    if (!a || typeof a !== 'object') return '';
    return a.path || a.file || a.filename || a.relativePath || a.query || a.pattern || a.dir || a.directory || a.term || '';
  }
  function toolLabel(name, args, detail) {
    if (name === 'step' && args && typeof args === 'object') {
      return { icon: '↳', title: `Step ${args.step}/${args.of}${args.task ? ': ' + args.task : ''}` };
    }
    if (name === 'think') {
      const th = String((args && typeof args === 'object' && args.thought) || '');
      return { icon: '◌', title: 'Thinking' + (th ? ': ' + th.replace(/\s+/g, ' ').trim().slice(0, 80) : '') };
    }
    const a = String(firstArg(args) || '');
    // Count lines in result to show an inline hint (e.g. “4 results”)
    const resultLines = detail ? detail.split('\n').filter(Boolean).length : 0;
    const hint = resultLines > 0 ? `${resultLines} line${resultLines === 1 ? '' : 's'}` : '';
    const M = {
      readFile:        ['⊞', a ? `read  ${a}` : 'read file'],
      listDir:         ['⊟', a ? `ls  ${a}` : 'list dir'],
      repoMap:         ['⊕', 'repo map'],
      searchWorkspace: ['⌕', a ? `grep  “${a}”` : 'grep workspace'],
      codebaseSearch:  ['⌕', a ? `search  “${a}”` : 'semantic search'],
      glob:            ['⊞', a ? `glob  ${a}` : 'glob'],
      grep:            ['⌕', a ? `grep  “${a}”` : 'grep'],
      webSearch:       ['⊙', a ? `web  “${a}”` : 'web search'],
      webFetch:        ['⊙', a ? `fetch  ${a}` : 'fetch URL'],
      getDiagnostics:  ['⊘', 'diagnostics'],
      runCommand:      ['▸', a ? `run  ${a}` : 'run command'],
      writeFile:       ['◈', a ? `write  ${a}` : 'write file'],
      createFile:      ['◈', a ? `create  ${a}` : 'create file'],
      editFile:        ['◈', a ? `edit  ${a}` : 'edit file'],
      deleteFile:      ['◉', a ? `delete  ${a}` : 'delete file'],
      impactAnalysis:  ['⊕', 'impact analysis'],
      buildGraph:      ['⊕', 'build graph'],
      getSymbolGraph:  ['⊕', 'symbol graph'],
      askUser:         ['◎', 'asking…'],
      skill:           ['◎', a ? `skill  ${a}` : 'skill'],
    };
    if (M[name]) return { icon: M[name][0], title: M[name][1], hint };
    if (name && name.indexOf('mcp__') === 0) {
      const p = name.split('__');
      return { icon: '⊛', title: `${p[1] || 'mcp'}  ${p.slice(2).join(' ') || 'tool'}`, hint };
    }
    return { icon: '◎', title: name || 'tool', hint };
  }
  const STATE_ICON = { running: null, done: '✓', error: '✗' };
  function upsertTool(t, msg) {
    if (msg.name === 'reasoning') {
      let block = t.tools.querySelector(`[data-tc="${msg.toolCallId}"]`);
      if (!block) { block = buildReasoningBlock(msg.detail || '', msg.toolCallId); t.tools.appendChild(block); }
      else {
        const b = block.querySelector('.think-body');
        if (b) { b.textContent = ''; b.appendChild(renderMarkdown(msg.detail || '')); }
        // Mark done: remove live highlight, update label
        if (msg.state === 'done') {
          block.dataset.live = '0';
          const cap = block.querySelector('.think-cap'); if (cap) cap.textContent = 'Thought';
          const ic = block.querySelector('.think-ic'); if (ic) ic.textContent = '◉';
        }
      }
      scrollDown();
      return;
    }
    let card = t.tools.querySelector(`[data-tc="${msg.toolCallId}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'tool-card';
      card.dataset.tc = msg.toolCallId;
      card.innerHTML = `<div class="tool-head"><span class="tool-ic"></span><span class="tool-title"></span><span class="tool-hint"></span><span class="state"></span></div><details class="tool-more hidden"><summary>output</summary><pre></pre></details>`;
      t.tools.appendChild(card);
    }
    const { icon, title, hint } = toolLabel(msg.name, msg.args, msg.detail);
    card.querySelector('.tool-ic').textContent = icon;
    card.querySelector('.tool-title').textContent = title;
    const hintEl = card.querySelector('.tool-hint');
    if (hintEl) hintEl.textContent = hint || '';
    const st = card.querySelector('.state');
    st.className = 'state ' + msg.state;
    const icon2 = STATE_ICON[msg.state];
    if (icon2 === null) { st.textContent = ''; } // CSS handles running dot
    else st.textContent = icon2 != null ? icon2 : msg.state;
    // State class on card for left-border colour
    card.className = 'tool-card state-' + msg.state;
    card.dataset.tc = msg.toolCallId;
    const argStr = (msg.args && typeof msg.args === 'object') ? JSON.stringify(msg.args, null, 2) : String(msg.args || '');
    const parts = [];
    if (argStr && argStr !== '{}') parts.push(argStr);
    if (msg.detail) parts.push(msg.detail);
    const more = card.querySelector('.tool-more');
    const body = parts.join('\n\n');
    if (body.trim()) { more.querySelector('pre').textContent = body; more.classList.remove('hidden'); }
    else more.classList.add('hidden');
    scrollDown();
  }

  // ---------- settings panel ----------
  let settingsOpen = false;
  function toggleSettings() {
    closeModelPop();
    closeAc();
    settingsOpen = !settingsOpen;
    settingsEl.classList.toggle('active', settingsOpen);
    thread.classList.toggle('hidden', settingsOpen);
    composer.classList.toggle('hidden', settingsOpen);
    if (settingsOpen) renderSettings();
  }

  let settingsTab = 'providers';
  // Which provider cards are expanded — preserved across re-renders so toggling
  // a model checkbox / setting a key (which pushes a fresh config) doesn't
  // collapse the card the user is working in.
  const expandedProviders = new Set();
  let settingsContentEl = null;
  let mcpResultsEl = null;
  let mcpSearchId = 0;
  let mcpSearchTimer;
  function renderSettings() {
    settingsEl.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'settings-bar';
    bar.innerHTML = '<b>Settings</b>';
    const back = document.createElement('button');
    back.className = 'secondary';
    back.textContent = '← Back to chat';
    back.addEventListener('click', toggleSettings);
    bar.appendChild(back);
    settingsEl.append(bar);

    // Filter box for the current tab (providers/models or MCP servers).
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'settings-search';
    search.placeholder = settingsTab === 'mcp' ? 'Search MCP servers…' : 'Search providers & models…';
    if (settingsTab === 'context' || settingsTab === 'others' || settingsTab === 'search') search.style.display = 'none';
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      settingsContentEl.querySelectorAll('.provider-card, .registry-row').forEach((el) => {
        el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
    settingsEl.append(search);

    const layout = document.createElement('div');
    layout.className = 'settings-layout';
    const nav = document.createElement('div');
    nav.className = 'settings-nav';
    [['providers', 'Providers'], ['search', 'webSearch'], ['mcp', 'MCP'], ['context', 'Context'], ['others', 'Others']].forEach((pair) => {
      const b = document.createElement('button');
      b.className = 'nav-item' + (settingsTab === pair[0] ? ' active' : '');
      b.textContent = pair[1];
      b.addEventListener('click', () => { settingsTab = pair[0]; renderSettings(); });
      nav.appendChild(b);
    });
    settingsContentEl = document.createElement('div');
    settingsContentEl.className = 'settings-content';
    layout.appendChild(nav);
    layout.appendChild(settingsContentEl);
    settingsEl.append(layout);

    if (settingsTab === 'providers') renderProviders();
    else if (settingsTab === 'search') renderSearchSection();
    else if (settingsTab === 'mcp') renderMcpSection();
    else if (settingsTab === 'others') renderOthersSection();
    else renderIndexSection();
  }

  // "Search" tab: pick a web search provider, set API keys, choose priority order.
  function renderSearchSection() {
    const wrap = document.createElement('div');
    wrap.className = 'others-section';
    const h = document.createElement('div'); h.className = 'others-title'; h.textContent = 'Web search';
    const desc = document.createElement('div'); desc.className = 'others-desc';
    desc.textContent = 'The agent uses webSearch to answer time-sensitive questions. Set a provider API key below — free tiers cover plenty. “Auto” tries Exa → Brave → custom → DuckDuckGo in order.';
    wrap.appendChild(h); wrap.appendChild(desc);

    // Priority picker
    const priorityRow = document.createElement('div'); priorityRow.className = 'search-priority-row';
    const pl = document.createElement('span'); pl.className = 'search-priority-label'; pl.textContent = 'Priority';
    const sel = document.createElement('select'); sel.className = 'search-priority-select';
    const opts = [
      ['auto', 'Auto (try all in order)'],
      ['exa', 'Exa first'],
      ['brave', 'Brave first'],
      ['custom', 'Custom endpoint first'],
      ['duckduckgo', 'DuckDuckGo only'],
    ];
    const currentPriority = state.searchPriority || 'auto';
    opts.forEach(([v, lbl]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = lbl;
      if (v === currentPriority) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => vscode.postMessage({ type: 'setSearchPriority', priority: sel.value }));
    priorityRow.appendChild(pl); priorityRow.appendChild(sel);
    wrap.appendChild(priorityRow);

    const list = document.createElement('div'); list.className = 'search-list';
    wrap.appendChild(list);

    const providers = state.searchProviders || [];
    providers.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'search-prov-row' + (p.hasKey ? ' configured' : '');
      const left = document.createElement('div'); left.className = 'sp-left';
      const name = document.createElement('div'); name.className = 'sp-name';
      name.innerHTML = `<span>${escapeHtml(p.name)}</span>${p.hasKey ? '<span class="sp-badge">ready</span>' : ''}`;
      const meta = document.createElement('div'); meta.className = 'sp-meta';
      meta.textContent = p.freeTier + (p.signupUrl ? ` · ${p.signupUrl}` : '');
      left.appendChild(name); left.appendChild(meta);
      const actions = document.createElement('div'); actions.className = 'sp-actions';
      if (p.id === 'custom') {
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'sp-input'; inp.placeholder = 'https://your-searxng.example/search?q='; inp.value = '';
        const save = document.createElement('button'); save.className = 'secondary'; save.textContent = 'Save URL';
        save.addEventListener('click', () => vscode.postMessage({ type: 'setSearchKey', provider: 'custom', key: inp.value.trim() }));
        actions.appendChild(inp); actions.appendChild(save);
      } else if (p.id === 'duckduckgo') {
        const note = document.createElement('span'); note.className = 'sp-note'; note.textContent = 'No key needed';
        actions.appendChild(note);
      } else {
        const btn = document.createElement('button'); btn.className = 'secondary';
        btn.textContent = p.hasKey ? 'Update key' : 'Set key';
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'setSearchKey', provider: p.id });
        });
        actions.appendChild(btn);
        if (p.hasKey) {
          const clear = document.createElement('button'); clear.className = 'icon-btn'; clear.textContent = 'Clear';
          clear.addEventListener('click', () => vscode.postMessage({ type: 'setSearchKey', provider: p.id, key: '' }));
          actions.appendChild(clear);
        }
        if (p.signupUrl) {
          const link = document.createElement('a'); link.className = 'sp-signup'; link.textContent = 'Get key'; link.href = '#';
          link.addEventListener('click', (ev) => { ev.preventDefault(); vscode.postMessage({ type: 'copyText', text: p.signupUrl }); });
          actions.appendChild(link);
        }
      }
      row.appendChild(left); row.appendChild(actions);
      list.appendChild(row);
    });

    settingsContentEl.appendChild(wrap);
  }

  // "Others" tab: pick the model used for chat titles + commit messages — an inline
  // searchable model list, same look/behavior as the chat-view model picker.
  function renderOthersSection() {
    const wrap = document.createElement('div');
    wrap.className = 'others-section';
    const h = document.createElement('div'); h.className = 'others-title'; h.textContent = 'Titles & commit messages';
    const desc = document.createElement('div'); desc.className = 'others-desc';
    desc.textContent = 'Model used for short utility tasks (chat titles, commit messages). "Auto" prefers a strong keyless model, so it works with no API key.';
    const search = document.createElement('input');
    search.type = 'text'; search.className = 'others-search'; search.placeholder = 'Search models…';
    const list = document.createElement('div'); list.className = 'others-list';
    wrap.appendChild(h); wrap.appendChild(desc); wrap.appendChild(search); wrap.appendChild(list);
    settingsContentEl.appendChild(wrap);

    const current = state.utilityModel || 'auto';
    const KEYLESS = ['ovh', 'pollinations', 'kilo'];
    const addItem = (value, label, searchText) => {
      const item = document.createElement('div');
      item.className = 'model-item' + (value === current ? ' selected' : '');
      item.dataset.search = searchText.toLowerCase();
      const lbl = document.createElement('span'); lbl.className = 'mi-label'; lbl.textContent = label;
      item.appendChild(lbl);
      item.addEventListener('click', () => vscode.postMessage({ type: 'setUtilityModel', model: value }));
      list.appendChild(item);
    };
    addItem('auto', 'Auto (prefers keyless)', 'auto keyless default');
    let lastPlatform = null;
    // Only show models from ACTIVE (key-set / keyless) AND checked providers —
    // same set the chat-view picker shows, and same set Auto routes over.
    const _disabledProviders = new Set(state.disabledProviders || []);
    const activePlatforms = new Set((state.platforms || []).filter((p) => p.configured && !_disabledProviders.has(p.platform)).map((p) => p.platform));
    const enabled = new Set(
      (state.fallback || [])
        .filter((e) => e.enabled && activePlatforms.has(e.platform))
        .map((e) => `${e.platform}::${e.modelId}`),
    );
    (state.catalog || []).forEach((m) => {
      if (!enabled.has(`${m.platform}::${m.modelId}`)) return;
      if (m.platform !== lastPlatform) {
        lastPlatform = m.platform;
        const g = document.createElement('div'); g.className = 'model-group';
        g.textContent = platformDisplayName(m.platform, m.modelId);
        list.appendChild(g);
      }
      const keyless = KEYLESS.includes(m.platform);
      const name = m.displayName + (keyless ? ' (keyless)' : '');
      const platName = platformDisplayName(m.platform, m.modelId);
      addItem(`${m.platform}::${m.modelId}`, name, `${name} ${platName}`);
    });
    // Custom endpoints: add enabled models (grouped by endpoint)
    const customModels = (state.fallback || []).filter((e) => e.platform === 'custom' && e.enabled);
    if (customModels.length > 0) {
      const byEndpoint = new Map();
      customModels.forEach((e) => {
        const epId = e.modelId.split('::')[0];
        if (!byEndpoint.has(epId)) byEndpoint.set(epId, []);
        byEndpoint.get(epId).push(e);
      });
      byEndpoint.forEach((models, epId) => {
        const ep = (state.customEndpoints || []).find((e) => e.id === epId);
        const g = document.createElement('div'); g.className = 'model-group';
        g.textContent = ep ? ep.name : 'Custom';
        list.appendChild(g);
        models.forEach((e) => {
          const upstreamId = e.modelId.split('::').slice(1).join('::');
          const name = upstreamId + (ep?.configured ? '' : ' (no key)');
          addItem(`custom::${e.modelId}`, name, `${name} ${ep ? ep.name : 'Custom'}`);
        });
      });
    }
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('.model-item').forEach((it) => { it.style.display = !q || it.dataset.search.includes(q) ? '' : 'none'; });
      list.querySelectorAll('.model-group').forEach((g) => { g.style.display = q ? 'none' : ''; });
    });

    // Usage data: persistent lifetime totals + a button to clear them.
    const usageWrap = document.createElement('div');
    usageWrap.className = 'usage-data-section';
    const usageTitle = document.createElement('div');
    usageTitle.className = 'others-title';
    usageTitle.textContent = 'Usage data';
    const usageDesc = document.createElement('div');
    usageDesc.className = 'others-desc';
    usageDesc.textContent = 'Lifetime token totals (persisted across sessions) and an estimated dollar amount you saved by using free tiers. Cleared manually only.';
    const usageStats = document.createElement('div');
    usageStats.className = 'usage-stats';
    usageStats.id = 'usage-stats-card';
    const usageClear = document.createElement('button');
    usageClear.className = 'secondary';
    usageClear.id = 'usage-clear-btn';
    usageClear.textContent = 'Clear usage data';
    usageClear.title = 'Reset the lifetime token and $ saved counters. This cannot be undone.';
    usageClear.addEventListener('click', () => {
      const ok = window.confirm('Clear all lifetime usage data? This will reset the persistent token and est. $ saved counters. This cannot be undone.');
      if (ok) {
        usageClear.disabled = true;
        usageClear.textContent = 'Clearing…';
        vscode.postMessage({ type: 'clearUsage' });
      }
    });
    usageWrap.append(usageTitle, usageDesc, usageStats, usageClear);
    settingsContentEl.appendChild(usageWrap);
    // Card was just built; populate it from the last known lifetime values
    // (the `config`/`usageTotals` messages update this same cache, so re-rendering
    // the tab while the user has it open still shows fresh numbers).
    renderUsageStatsCard();
  }

  function renderProviders() {
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.marginBottom = '8px';
    hint.textContent = 'Click a provider to edit its endpoint and enable models. Set a per-model API key on each model row. Configured providers (green) are listed first.';
    settingsContentEl.appendChild(hint);

    const cat = {};
    state.catalog.forEach((m) => { cat[m.platform + '::' + m.modelId] = m; });
    const modelsByPlatform = {};
    state.fallback.forEach((e) => { (modelsByPlatform[e.platform] = modelsByPlatform[e.platform] || []).push(e); });
    const entries = state.fallback.slice();

    // Configured (or keyless) providers first, then alphabetical.
    const provs = state.platforms.slice().sort((a, b) =>
      (Number(!!b.configured) - Number(!!a.configured)) || a.name.localeCompare(b.name));

    provs.forEach((p) => {
      // Skip the old 'custom' platform card — we now have a dedicated custom endpoints section
      if (p.platform === 'custom') return;

      const card = document.createElement('div');
      card.className = 'provider-card';

      const dotClass = !p.configured ? 'missing'
        : p.status === 'invalid' ? 'invalid'
        : p.status === 'rate_limited' ? 'rate_limited' : 'healthy';
      const isOpen = expandedProviders.has(p.platform);
      const keyCount = p.keyCount || 0;
      const keyStatusText = p.keyless ? 'keyless'
        : keyCount > 1 ? `${keyCount} keys · rotating`
        : keyCount === 1 ? 'key set'
        : 'no key';
      const keyBtnText = p.keyless ? 'Keyless'
        : keyCount > 0 ? 'Add key'
        : 'Set key';
      const keyBtnTitle = p.keyless ? 'Keyless provider'
        : keyCount > 0 ? 'Add another API key to the rotation pool'
        : 'Set API key';
      const provModels = modelsByPlatform[p.platform] || [];
      const isProviderDisabled = (state.disabledProviders || []).includes(p.platform);
      const head = document.createElement('div');
      head.className = 'provider-head';
      head.innerHTML = `
        <span class="status-dot status-${dotClass}"></span>
        <span class="provider-name">${escapeHtml(p.name)}</span>
        <span class="muted prov-status">${keyStatusText}</span>
        <button class="icon-btn prov-key-btn" data-platform="${p.platform}" title="${keyBtnTitle}">${keyBtnText}</button>
        <span class="chev">${isOpen ? '▾' : '▸'}</span>`;

      // Provider on/off toggle switch — inserted before the status dot.
      const sw = document.createElement('label');
      sw.className = 'prov-switch';
      sw.title = `Enable / disable all models for ${p.name}`;
      const swCb = document.createElement('input');
      swCb.type = 'checkbox';
      swCb.checked = !isProviderDisabled;
      const swTrack = document.createElement('span');
      swTrack.className = 'sw-track';
      const swThumb = document.createElement('span');
      swThumb.className = 'sw-thumb';
      swTrack.appendChild(swThumb);
      sw.appendChild(swCb);
      sw.appendChild(swTrack);
      head.insertBefore(sw, head.firstChild);
      sw.addEventListener('click', (ev) => ev.stopPropagation());
      swCb.addEventListener('change', () => {
        vscode.postMessage({ type: 'setProviderEnabled', platform: p.platform, enabled: swCb.checked });
      });

      const body = document.createElement('div');
      body.className = 'provider-body' + (isOpen ? '' : ' hidden');
      head.addEventListener('click', () => {
        const closed = body.classList.toggle('hidden');
        head.querySelector('.chev').textContent = closed ? '▸' : '▾';
        if (closed) expandedProviders.delete(p.platform);
        else expandedProviders.add(p.platform);
      });

      // Provider-level key button in the header
      const provKeyBtn = head.querySelector('.prov-key-btn');
      if (provKeyBtn) {
        provKeyBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (p.keyless) return;
          vscode.postMessage(keyCount > 0 ? { type: 'addKey', platform: p.platform } : { type: 'setKey', platform: p.platform });
        });
      }

      // Endpoint
      const epInput = document.createElement('input');
      epInput.type = 'text';
      epInput.className = 'endpoint';
      epInput.placeholder = p.defaultBaseUrl || '';
      epInput.value = p.endpoint || '';
      body.appendChild(epInput);
      const epRow = document.createElement('div');
      epRow.className = 'row-actions';
      epRow.style.marginTop = '4px';
      const saveEp = document.createElement('button');
      saveEp.className = 'secondary';
      saveEp.textContent = 'Save URL';
      saveEp.addEventListener('click', () => {
        const url = epInput.value.trim();
        if (url && !/^https?:\/\/.+/i.test(url)) { card.classList.add('invalid'); return; }
        card.classList.remove('invalid');
        vscode.postMessage({ type: 'setEndpoint', platform: p.platform, url });
      });
      const resetEp = document.createElement('button');
      resetEp.className = 'icon-btn';
      resetEp.textContent = 'Reset';
      resetEp.addEventListener('click', () => { epInput.value = ''; vscode.postMessage({ type: 'resetEndpoint', platform: p.platform }); });
      epRow.appendChild(saveEp);
      epRow.appendChild(resetEp);
      body.appendChild(epRow);

      // Key pool management (only for keyed, non-custom providers)
      if (!p.keyless) {
        const keyHints = p.keyHints || [];
        if (keyHints.length > 0) {
          const keySecTitle = document.createElement('div');
          keySecTitle.className = 'muted prov-models-title';
          keySecTitle.textContent = keyHints.length > 1 ? `API Keys (${keyHints.length} · rotating on rate-limit)` : 'API Key';
          body.appendChild(keySecTitle);

          const chips = document.createElement('div');
          chips.className = 'key-chips';
          keyHints.forEach((hint, idx) => {
            const chip = document.createElement('div');
            chip.className = 'key-chip';
            const span = document.createElement('span');
            span.className = 'key-hint';
            span.textContent = hint;
            const del = document.createElement('button');
            del.className = 'key-del icon-btn';
            del.title = 'Remove this key';
            del.textContent = '✕';
            let confirming = false;
            let cancelBtn = null;
            del.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (!confirming) {
                confirming = true;
                chip.classList.add('confirming');
                span.textContent = 'Remove this key?';
                del.textContent = 'Yes';
                del.style.color = 'var(--vscode-errorForeground)';
                del.style.opacity = '1';
                cancelBtn = document.createElement('button');
                cancelBtn.className = 'icon-btn';
                cancelBtn.textContent = 'No';
                cancelBtn.style.opacity = '1';
                cancelBtn.addEventListener('click', (e) => {
                  e.stopPropagation();
                  confirming = false;
                  chip.classList.remove('confirming');
                  span.textContent = hint;
                  del.textContent = '✕';
                  del.style.color = '';
                  del.style.opacity = '';
                  cancelBtn.remove();
                  cancelBtn = null;
                });
                chip.appendChild(cancelBtn);
              } else {
                vscode.postMessage({ type: 'removeKeyAt', platform: p.platform, index: idx });
              }
            });
            chip.appendChild(span);
            chip.appendChild(del);
            chips.appendChild(chip);
          });
          body.appendChild(chips);
        }
      }

      // Models for this provider (enable toggles)
      const models = modelsByPlatform[p.platform] || [];
      if (models.length) {
        const mt = document.createElement('div');
        mt.className = 'muted prov-models-title';
        mt.textContent = isProviderDisabled ? 'Models (provider off — not routing)' : 'Models';
        body.appendChild(mt);
      }
      const modelKeySet = new Set(state.modelKeys || []);
      models.forEach((e) => {
        const idx = entries.findIndex((x) => x.platform === e.platform && x.modelId === e.modelId);
        const m = cat[e.platform + '::' + e.modelId] || {};
        const caps = [];
        if (m.supportsTools) caps.push('T');
        if (m.supportsVision) caps.push('V');
        if (m.supportsReasoning) caps.push('R');
        const row = document.createElement('div');
        row.className = 'pm-row';
        if (isProviderDisabled) row.style.opacity = '.4';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!e.enabled;
        cb.addEventListener('change', () => { entries[idx].enabled = cb.checked; vscode.postMessage({ type: 'setFallbackConfig', entries }); });
        const info = document.createElement('div');
        info.className = 'pm-info';
        info.innerHTML = `<div class="pm-name">${escapeHtml(m.displayName || e.modelId)}</div>
          <div class="meta">ctx ${m.contextWindow ? (m.contextWindow / 1000) + 'k' : '?'} · ${escapeHtml(m.sizeLabel || '')} · ${escapeHtml(m.monthlyTokenBudget || '')}</div>`;
        const capsEl = document.createElement('div');
        capsEl.className = 'caps';
        capsEl.innerHTML = caps.map((c) => `<span class="cap" title="${c === 'T' ? 'tools' : c === 'V' ? 'vision' : 'reasoning'}">${c}</span>`).join('');
        row.appendChild(cb);
        row.appendChild(info);
        row.appendChild(capsEl);
        // Per-model key button (skipped for keyless platforms; optional override otherwise).
        if (!p.keyless) {
          const hasKey = modelKeySet.has(`${e.platform}::${e.modelId}`);
          const keyBtn = document.createElement('button');
          keyBtn.className = 'icon-btn';
          keyBtn.textContent = hasKey ? 'Key ✓' : 'Key';
          keyBtn.title = hasKey
            ? 'This model has a custom API key (overrides the provider key). Click to manage.'
            : 'Set a custom API key for this model (overrides the provider key).';
          keyBtn.addEventListener('click', async () => {
            const action = hasKey ? 'Update' : 'Set';
            const res = await inlineDialog({
              title: `${action} API key — ${m.displayName || e.modelId}`,
              fields: [{ label: 'API key (leave empty to clear)', secret: true }],
              okLabel: action,
            });
            if (res === null) return; // cancelled
            const next = (res[0] || '').trim();
            if (next === '') {
              vscode.postMessage({ type: 'clearModelKey', platform: e.platform, modelId: e.modelId });
            } else {
              vscode.postMessage({ type: 'setModelKey', platform: e.platform, modelId: e.modelId, key: next });
            }
          });
          row.appendChild(keyBtn);
        }
        body.appendChild(row);
      });

      card.appendChild(head);
      card.appendChild(body);
      settingsContentEl.appendChild(card);
    });

    // ============ CUSTOM ENDPOINTS SECTION ============
    const customEndpoints = (state.customEndpoints || []);
    if (customEndpoints.length > 0 || true) { // Always show the section
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'section-title';
      sectionTitle.style.marginTop = '24px';
      sectionTitle.style.marginBottom = '8px';
      sectionTitle.textContent = 'Custom endpoints (OpenAI-compatible)';
      settingsContentEl.appendChild(sectionTitle);

      const addBtn = document.createElement('button');
      addBtn.className = 'secondary';
      addBtn.textContent = '+ Add custom endpoint';
      addBtn.style.marginBottom = '16px';
      addBtn.addEventListener('click', async () => {
        const res = await inlineDialog({
          title: 'Add custom endpoint',
          fields: [
            { label: 'Name', placeholder: 'e.g., vLLM, My LiteLLM' },
            { label: 'Base URL', placeholder: 'http://localhost:8000/v1' },
          ],
          okLabel: 'Add',
        });
        if (!res) return;
        const name = (res[0] || '').trim();
        const url = (res[1] || '').trim();
        if (!name || !url) return;
        vscode.postMessage({ type: 'addCustomEndpoint', name, baseUrl: url });
      });
      settingsContentEl.appendChild(addBtn);

      customEndpoints.forEach((ep) => {
        const card = document.createElement('div');
        card.className = 'provider-card custom-endpoint-card';

        const isOpen = expandedProviders.has('custom_' + ep.id);
        const keyStatusText = ep.configured ? 'key set' : 'no key';
        const head = document.createElement('div');
        head.className = 'provider-head';
        head.innerHTML = `
          <span class="status-dot status-${ep.configured ? 'healthy' : 'missing'}"></span>
          <span class="provider-name">${escapeHtml(ep.name)}</span>
          <span class="muted prov-models-title">${ep.modelCount} model${ep.modelCount === 1 ? '' : 's'}</span>
          <span class="chev">${isOpen ? '▾' : '▸'}</span>
        `;

        const body = document.createElement('div');
        body.className = 'provider-body' + (isOpen ? '' : ' hidden');
        head.addEventListener('click', () => {
          const closed = body.classList.toggle('hidden');
          head.querySelector('.chev').textContent = closed ? '▸' : '▾';
          if (closed) expandedProviders.delete('custom_' + ep.id);
          else expandedProviders.add('custom_' + ep.id);
        });

        // Name display + edit button
        const nameRow = document.createElement('div');
        nameRow.style.marginBottom = '8px';
        nameRow.innerHTML = `<span class="muted">Name: </span><strong>${escapeHtml(ep.name)}</strong>`;
        const editNameBtn = document.createElement('button');
        editNameBtn.className = 'icon-btn';
        editNameBtn.textContent = 'Rename';
        editNameBtn.style.marginLeft = '8px';
        editNameBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const res = await inlineDialog({
            title: 'Rename endpoint',
            fields: [{ label: 'Name', value: ep.name }],
            okLabel: 'Rename',
          });
          const newName = res ? (res[0] || '').trim() : '';
          if (newName && newName !== ep.name) {
            vscode.postMessage({ type: 'updateCustomEndpoint', id: ep.id, name: newName });
          }
        });
        nameRow.appendChild(editNameBtn);
        body.appendChild(nameRow);

        // Base URL input + Save button
        const epInput = document.createElement('input');
        epInput.type = 'text';
        epInput.className = 'endpoint';
        epInput.placeholder = 'https://...';
        epInput.value = ep.baseUrl;
        body.appendChild(epInput);
        const epRow = document.createElement('div');
        epRow.className = 'row-actions';
        epRow.style.marginTop = '4px';
        const saveEp = document.createElement('button');
        saveEp.className = 'secondary';
        saveEp.textContent = 'Save URL';
        saveEp.addEventListener('click', () => {
          const url = epInput.value.trim();
          if (!/^https?:\/\/.+/i.test(url)) {
            void inlineDialog({ title: 'Invalid base URL', message: 'Base URL must start with http:// or https://', okLabel: 'OK' });
            return;
          }
          vscode.postMessage({ type: 'updateCustomEndpoint', id: ep.id, baseUrl: url });
        });
        const resetEp = document.createElement('button');
        resetEp.className = 'icon-btn';
        resetEp.textContent = 'Reset';
        resetEp.addEventListener('click', () => { epInput.value = ep.baseUrl; });
        epRow.appendChild(saveEp);
        epRow.appendChild(resetEp);
        body.appendChild(epRow);

        // Key status + Set/Update/Clear button
        const keyRow = document.createElement('div');
        keyRow.style.marginTop = '8px';
        keyRow.innerHTML = `<span class="muted">Key: </span><span>${ep.configured ? '•••• Set' : 'Not set'}</span>`;
        const keyBtn = document.createElement('button');
        keyBtn.className = 'secondary';
        keyBtn.textContent = ep.configured ? 'Update key' : 'Set key';
        keyBtn.style.marginLeft = '8px';
        keyBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const action = ep.configured ? 'Update' : 'Set';
          const res = await inlineDialog({
            title: `${action} API key — ${ep.name}`,
            fields: [{ label: 'API key (leave empty to clear)', secret: true }],
            okLabel: action,
          });
          if (res !== null) {
            vscode.postMessage({ type: 'setCustomEndpointKey', id: ep.id, key: (res[0] || '').trim() });
          }
        });
        keyRow.appendChild(keyBtn);
        if (ep.configured) {
          const clearKeyBtn = document.createElement('button');
          clearKeyBtn.className = 'icon-btn';
          clearKeyBtn.textContent = 'Clear';
          clearKeyBtn.style.marginLeft = '4px';
          clearKeyBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            vscode.postMessage({ type: 'setCustomEndpointKey', id: ep.id, key: null });
          });
          keyRow.appendChild(clearKeyBtn);
        }
        body.appendChild(keyRow);

        // Models section
        const mt = document.createElement('div');
        mt.className = 'muted prov-models-title';
        mt.style.marginTop = '12px';
        mt.textContent = 'Models';
        body.appendChild(mt);

        // Get models for this endpoint from fallback chain
        const epModels = state.fallback.filter((e) => e.platform === 'custom' && e.modelId.startsWith(ep.id + '::'));
        if (epModels.length === 0) {
          const emptyHint = document.createElement('div');
          emptyHint.className = 'muted';
          emptyHint.style.marginBottom = '8px';
          emptyHint.textContent = 'No models yet. Add a model ID to get started.';
          body.appendChild(emptyHint);
        }

        epModels.forEach((e) => {
          const idx = entries.findIndex((x) => x.platform === e.platform && x.modelId === e.modelId);
          const upstreamId = e.modelId.split('::').slice(1).join('::');
          const row = document.createElement('div');
          row.className = 'pm-row';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!e.enabled;
          cb.addEventListener('change', () => { entries[idx].enabled = cb.checked; vscode.postMessage({ type: 'setFallbackConfig', entries }); });
          const info = document.createElement('div');
          info.className = 'pm-info';
          info.innerHTML = `<div class="pm-name">${escapeHtml(upstreamId)}</div>`;
          const delBtn = document.createElement('button');
          delBtn.className = 'icon-btn';
          delBtn.textContent = '✕';
          delBtn.title = 'Remove model';
          delBtn.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            if (await inlineDialog({ title: 'Remove model?', message: `Remove "${upstreamId}" from this endpoint?`, okLabel: 'Remove', danger: true })) {
              vscode.postMessage({ type: 'removeCustomModel', endpointId: ep.id, modelId: upstreamId });
            }
          });
          row.appendChild(cb);
          row.appendChild(info);
          row.appendChild(delBtn);
          body.appendChild(row);
        });

        // Add model button
        const addModelRow = document.createElement('div');
        addModelRow.style.marginTop = '8px';
        const addModelBtn = document.createElement('button');
        addModelBtn.className = 'secondary';
        addModelBtn.textContent = '+ Add model';
        addModelBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const res = await inlineDialog({
            title: 'Add model',
            fields: [{ label: 'Model ID', placeholder: 'e.g., llama-3.1-8b-instruct' }],
            okLabel: 'Add',
          });
          const modelId = res ? (res[0] || '').trim() : '';
          if (!modelId) return;
          vscode.postMessage({ type: 'addCustomModel', endpointId: ep.id, modelId });
        });
        addModelRow.appendChild(addModelBtn);
        body.appendChild(addModelRow);

        // Remove endpoint button
        const removeRow = document.createElement('div');
        removeRow.style.marginTop = '16px';
        const removeBtn = document.createElement('button');
        removeBtn.className = 'icon-btn';
        removeBtn.style.color = 'var(--vscode-errorForeground)';
        removeBtn.textContent = 'Remove endpoint';
        removeBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (await inlineDialog({ title: 'Remove endpoint?', message: `Remove "${ep.name}"? This removes all its models and keys.`, okLabel: 'Remove', danger: true })) {
            vscode.postMessage({ type: 'removeCustomEndpoint', id: ep.id });
          }
        });
        removeRow.appendChild(removeBtn);
        body.appendChild(removeRow);

        card.appendChild(head);
        card.appendChild(body);
        settingsContentEl.appendChild(card);
      });
    }
  }

  function renderIndexSection() {
    const idx = state.index || {};
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'Codebase Index (semantic search)';
    settingsContentEl.appendChild(title);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Embeds your code so the agent can search by meaning and auto-inject relevant snippets each turn. Builds automatically once enabled with a provider key — progress shows above the chat box.';
    settingsContentEl.appendChild(hint);

    // Enable toggle
    const enableRow = document.createElement('label');
    enableRow.className = 'pm-row';
    const enableCb = document.createElement('input');
    enableCb.type = 'checkbox';
    enableCb.checked = !!idx.enabled;
    enableCb.addEventListener('change', () => vscode.postMessage({ type: 'setEmbeddingsEnabled', enabled: enableCb.checked }));
    const enLbl = document.createElement('span');
    enLbl.textContent = 'Enable codebase index';
    enableRow.appendChild(enableCb);
    enableRow.appendChild(enLbl);
    settingsContentEl.appendChild(enableRow);

    // Embedding provider + key
    const provRow = document.createElement('div');
    provRow.className = 'row-actions';
    provRow.style.margin = '6px 0';
    const provLabel = document.createElement('span');
    provLabel.className = 'muted';
    provLabel.textContent = 'Embeddings via';
    const provSel = document.createElement('select');
    provSel.className = 'pill';
    ['google', 'cohere', 'mistral', 'openrouter', 'github', 'nvidia'].forEach((p) => {
      const o = document.createElement('option');
      o.value = p; o.textContent = p;
      if (p === idx.provider) o.selected = true;
      provSel.appendChild(o);
    });
    provSel.addEventListener('change', () => vscode.postMessage({ type: 'setEmbeddingsProvider', provider: provSel.value }));
    const keyDot = document.createElement('span');
    keyDot.className = 'status-dot status-' + (idx.providerConfigured ? 'healthy' : 'missing');
    const keyBtn = document.createElement('button');
    keyBtn.className = 'secondary';
    keyBtn.textContent = idx.providerConfigured ? 'Key set' : 'Set key';
    keyBtn.addEventListener('click', () => vscode.postMessage({ type: 'setKey', platform: idx.provider }));
    provRow.appendChild(provLabel);
    provRow.appendChild(provSel);
    provRow.appendChild(keyDot);
    provRow.appendChild(keyBtn);
    settingsContentEl.appendChild(provRow);

    const status = document.createElement('div');
    status.className = 'muted';
    status.style.margin = '4px 0';
    status.textContent = idx.building ? 'Indexing…'
      : idx.built ? `Indexed: ${idx.chunks} chunks · ${idx.files} files · ${escapeHtml(idx.model || '')}`
      : 'Not built yet.';
    settingsContentEl.appendChild(status);
    if (idx.lastError) { const e = document.createElement('div'); e.className = 'error'; e.textContent = idx.lastError; settingsContentEl.appendChild(e); }
    if (idx.enabled && !idx.providerConfigured) {
      const warn = document.createElement('div');
      warn.className = 'muted';
      warn.textContent = `Set an API key for "${idx.provider}" to build the index.`;
      settingsContentEl.appendChild(warn);
    }

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const build = document.createElement('button');
    build.className = 'secondary';
    build.textContent = idx.built ? 'Rebuild index' : 'Build index';
    build.disabled = !idx.enabled || !idx.providerConfigured || !!idx.building;
    build.addEventListener('click', () => vscode.postMessage({ type: 'buildIndex' }));
    const clear = document.createElement('button');
    clear.className = 'icon-btn';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => vscode.postMessage({ type: 'clearIndex' }));
    actions.appendChild(build);
    actions.appendChild(clear);
    settingsContentEl.appendChild(actions);

    // ---- Performance Cache subsection ----
    const cacheStats = state.cacheStats || { fileCache: { entries: 0, sizeKb: 0, enabled: true }, searchCache: { entries: 0, enabled: true } };
    const cacheTitle = document.createElement('div');
    cacheTitle.className = 'section-title';
    cacheTitle.style.marginTop = '18px';
    cacheTitle.textContent = 'Performance Cache';
    settingsContentEl.appendChild(cacheTitle);
    const cacheHint = document.createElement('div');
    cacheHint.className = 'muted';
    cacheHint.textContent = 'In-memory caches that prevent re-reading files and re-running searches during an agent run. Saves rate-limit quota on free LLMs.';
    settingsContentEl.appendChild(cacheHint);

    // File cache row
    const fileRow = document.createElement('div');
    fileRow.className = 'row-actions';
    fileRow.style.marginTop = '8px';
    const fileLbl = document.createElement('span');
    fileLbl.style.flex = '1';
    fileLbl.innerHTML = '<strong>File cache</strong> <span class="muted">' +
      (cacheStats.fileCache.entries > 0 ? `${cacheStats.fileCache.entries} files · ${cacheStats.fileCache.sizeKb} KB` : 'empty') + '</span>';
    const fileToggle = document.createElement('input');
    fileToggle.type = 'checkbox';
    fileToggle.checked = !!cacheStats.fileCache.enabled;
    fileToggle.title = 'Enable file read cache';
    fileToggle.addEventListener('change', () => vscode.postMessage({ type: 'setCacheEnabled', key: 'file', enabled: fileToggle.checked }));
    const fileClear = document.createElement('button');
    fileClear.className = 'icon-btn';
    fileClear.textContent = 'Clear';
    fileClear.disabled = cacheStats.fileCache.entries === 0;
    fileClear.addEventListener('click', () => vscode.postMessage({ type: 'clearFileCache' }));
    fileRow.appendChild(fileLbl);
    fileRow.appendChild(fileToggle);
    fileRow.appendChild(fileClear);
    settingsContentEl.appendChild(fileRow);

    // Search cache row
    const searchRow = document.createElement('div');
    searchRow.className = 'row-actions';
    searchRow.style.marginTop = '4px';
    const searchLbl = document.createElement('span');
    searchLbl.style.flex = '1';
    searchLbl.innerHTML = '<strong>Search cache</strong> <span class="muted">' +
      (cacheStats.searchCache.entries > 0 ? `${cacheStats.searchCache.entries} queries cached` : 'empty') + ' · 30 s TTL</span>';
    const searchToggle = document.createElement('input');
    searchToggle.type = 'checkbox';
    searchToggle.checked = !!cacheStats.searchCache.enabled;
    searchToggle.title = 'Enable grep / search cache';
    searchToggle.addEventListener('change', () => vscode.postMessage({ type: 'setCacheEnabled', key: 'search', enabled: searchToggle.checked }));
    const searchClear = document.createElement('button');
    searchClear.className = 'icon-btn';
    searchClear.textContent = 'Clear';
    searchClear.disabled = cacheStats.searchCache.entries === 0;
    searchClear.addEventListener('click', () => vscode.postMessage({ type: 'clearSearchCache' }));
    searchRow.appendChild(searchLbl);
    searchRow.appendChild(searchToggle);
    searchRow.appendChild(searchClear);
    settingsContentEl.appendChild(searchRow);

    // Clear all button
    const cacheActions = document.createElement('div');
    cacheActions.className = 'row-actions';
    cacheActions.style.marginTop = '6px';
    const clearAll = document.createElement('button');
    clearAll.className = 'icon-btn';
    clearAll.textContent = 'Clear all caches';
    clearAll.disabled = cacheStats.fileCache.entries === 0 && cacheStats.searchCache.entries === 0;
    clearAll.addEventListener('click', () => vscode.postMessage({ type: 'clearAllCaches' }));
    cacheActions.appendChild(clearAll);
    settingsContentEl.appendChild(cacheActions);
  }

  function renderMcpSection() {
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'MCP Servers';
    settingsContentEl.appendChild(title);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Tools from configured MCP servers are available to the agent. Edit in settings.json (tiermux.mcpServers).';
    settingsContentEl.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.style.margin = '6px 0';
    const editBtn = document.createElement('button');
    editBtn.className = 'secondary';
    editBtn.textContent = 'Edit servers (settings.json)';
    editBtn.addEventListener('click', () => vscode.postMessage({ type: 'editMcp' }));
    const reBtn = document.createElement('button');
    reBtn.className = 'icon-btn';
    reBtn.textContent = '⟳ Reconnect';
    reBtn.addEventListener('click', () => vscode.postMessage({ type: 'reconnectMcp' }));
    actions.appendChild(editBtn);
    actions.appendChild(reBtn);
    settingsContentEl.appendChild(actions);

    const servers = state.mcp || [];
    if (!servers.length) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.textContent = 'No MCP servers configured yet — add one below.';
      settingsContentEl.appendChild(none);
    }
    servers.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'provider-card';
      const dot = s.status === 'connected' ? 'healthy' : s.status === 'error' ? 'invalid' : 'missing';
      const head = document.createElement('div');
      head.className = 'provider-head';
      head.innerHTML = `<span class="status-dot status-${dot}"></span><span class="provider-name">${escapeHtml(s.name)}</span><span class="muted prov-status">${s.status === 'connected' ? s.toolCount + ' tools' : escapeHtml(s.status)}</span>`;
      const rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.textContent = '✕';
      rm.title = 'Remove server';
      rm.style.marginLeft = 'auto'; // group the controls at the right edge
      rm.addEventListener('click', (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'removeMcpServer', name: s.name }); });
      head.appendChild(rm);
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.style.marginLeft = '0'; // the remove button already claims the gap
      chev.textContent = '▸';
      head.appendChild(chev);
      const body = document.createElement('div');
      body.className = 'provider-body hidden';
      head.addEventListener('click', () => { const closed = body.classList.toggle('hidden'); chev.textContent = closed ? '▸' : '▾'; });
      if (s.error) { const er = document.createElement('div'); er.className = 'error'; er.textContent = s.error; body.appendChild(er); }
      (s.tools || []).forEach((t) => {
        const r = document.createElement('div');
        r.className = 'pm-row';
        r.innerHTML = `<span class="ac-icon">◈</span><div class="pm-info"><div class="pm-name">${escapeHtml(t)}</div></div>`;
        body.appendChild(r);
      });
      card.appendChild(head);
      card.appendChild(body);
      settingsContentEl.appendChild(card);
    });

    // Marketplace: browse curated + search the remote registry.
    const mt = document.createElement('div');
    mt.className = 'section-title';
    mt.textContent = 'Add a server';
    settingsContentEl.appendChild(mt);

    const rsearch = document.createElement('input');
    rsearch.type = 'text';
    rsearch.className = 'settings-search';
    rsearch.placeholder = 'Search the MCP registry (remote)… — empty shows curated';
    settingsContentEl.appendChild(rsearch);

    mcpResultsEl = document.createElement('div');
    settingsContentEl.appendChild(mcpResultsEl);
    renderMcpItems(state.mcpRegistry || []);

    rsearch.addEventListener('input', () => {
      const q = rsearch.value.trim();
      if (!q) { renderMcpItems(state.mcpRegistry || []); return; }
      const id = ++mcpSearchId;
      mcpResultsEl.innerHTML = '<div class="muted">Searching the registry…</div>';
      clearTimeout(mcpSearchTimer);
      mcpSearchTimer = setTimeout(() => vscode.postMessage({ type: 'searchMcpRegistry', queryId: id, query: q }), 350);
    });
  }

  function renderMcpItems(items) {
    if (!mcpResultsEl) return;
    mcpResultsEl.innerHTML = '';
    if (!items.length) { mcpResultsEl.innerHTML = '<div class="muted">No servers found.</div>'; return; }
    const configured = new Set((state.mcp || []).map((s) => s.name));
    items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'registry-row';
      const info = document.createElement('div');
      info.className = 'pm-info';
      info.innerHTML = `<div class="pm-name">${escapeHtml(item.name)}</div><div class="meta">${escapeHtml(item.description || '')}</div>`;
      const add = document.createElement('button');
      const already = configured.has(item.id);
      add.className = 'secondary';
      add.textContent = already ? 'Added' : 'Add';
      add.disabled = already;
      add.addEventListener('click', () => vscode.postMessage({ type: 'addMcpServer', item }));
      row.appendChild(info);
      row.appendChild(add);
      mcpResultsEl.appendChild(row);
    });
  }

  // ---------- inbound messages ----------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    // This webview renders one session at a time. Render messages for a different
    // (background) session are ignored here — the host caches their state and replays it
    // when we switch to them (see switchSession). switchSession/sessionList carry their own
    // sessionId semantics and are handled below, so they're excluded from this filter.
    const PER_SESSION = new Set(['userEcho', 'assistantStart', 'agentStep', 'toolStatus', 'todos', 'failoverNotice', 'keyRotated', 'assistantMessage', 'assistantChunk', 'planProposed', 'planDiscarded', 'commandApproval', 'editApproval', 'clarifyingQuestions', 'askUserPrompt', 'askUserDismissed', 'checkpoint', 'changedFiles', 'busy', 'notice', 'error']);
    if (PER_SESSION.has(msg.type) && msg.sessionId && viewedSessionId && msg.sessionId !== viewedSessionId) return;
    switch (msg.type) {
      case 'config':
        state = msg.config;
        autoApprove = !!state.autoApprove;
        renderAutoApprove();
        rebuildModelPicker();
        updateFooter(msg.usageTotals);
        renderUsageStatsCard(msg.usageTotals && msg.usageTotals.lifetime);
        renderIndexStatus(state.index && state.index.building ? { building: true, done: 0, total: 0, phase: 'embedding' } : { building: false });
        if (settingsOpen) renderSettings();
        break;
      case 'userEcho':
        addUserBubble(msg.text, msg.requestId);
        break;
      case 'switchSession':
        // Rebuild this single-session view for the session we're now viewing. Its full
        // transcript is replayed, then the host re-emits any cached live/cards state.
        saveComposer(viewedSessionId); // stash the leaving session's draft/settings
        viewedSessionId = msg.sessionId;
        if (settingsOpen) toggleSettings();
        thread.innerHTML = '';
        targets.clear();
        userTargets.clear();
        startTimes.clear();
        statusTimers.forEach((id) => clearInterval(id));
        statusTimers.clear();
        currentTurn = null;
        renderChangedBar({ files: [] });
        (msg.messages || []).forEach((mm) => mm.role === 'user' ? addUserBubble(mm.text, mm.requestId, mm.ts) : renderAssistantStatic(mm.text, mm.model, mm.ts, mm.secs, { reasoning: mm.reasoning, steps: mm.steps, usage: mm.usage }));
        if (!(msg.messages || []).length) renderEmpty();
        loadComposer(viewedSessionId); // restore the entering session's draft/settings
        scrollDown();
        break;
      case 'sessionList':
        sessionList = msg.sessions || [];
        renderTabs();
        break;
      case 'setInput':
        input.value = msg.text || '';
        input.focus();
        autoGrow();
        break;
      case 'toggleSettings':
        toggleSettings();
        break;
      case 'toggleHistory':
        toggleHistory();
        break;
      case 'assistantStart': {
        const t = ensureTarget(msg.requestId, msg.platform, msg.model);
        // The target may have been created earlier by a failover notice (which
        // carries no model) — set it now so the footer shows the model that
        // actually produced the answer, not a blank.
        if (msg.model) t.model = `${msg.platform || ''}/${msg.model}`;
        startStatusTimer(msg.requestId);
        break;
      }
      case 'agentStep': {
        const t = ensureTarget(msg.requestId);
        if (t.statusLabel) t.statusLabel.textContent = msg.label;
        startStatusTimer(msg.requestId);
        scrollDown();
        break;
      }
      case 'todos': {
        const t = ensureTarget(msg.requestId);
        renderTodos(t, msg.todos || [], !!msg.followingPlan);
        break;
      }
      case 'toolStatus': {
        const t = ensureTarget(msg.requestId);
        if (msg.state === 'running' && t.statusLabel) t.statusLabel.textContent = toolVerb(msg.name, msg.args);
        upsertTool(t, msg);
        break;
      }
      case 'failoverNotice': {
        const t = ensureTarget(msg.requestId);
        // Collapse the cascade into one rolling line instead of a line per failure.
        t.failoverCount = (t.failoverCount || 0) + 1;
        if (!t.failoverEl) {
          t.failoverEl = document.createElement('div');
          t.failoverEl.className = 'notice';
          t.tools.appendChild(t.failoverEl);
        }
        // Neutral, non-alarming wording — failover is normal routing, not an error.
        t.failoverEl.textContent = '↻ Routing to the best available model…';
        t.failoverEl.title = `Switched models ${t.failoverCount}× · last: ${msg.from} (${msg.reason})`;
        scrollDown();
        break;
      }
      case 'keyRotated': {
        const t = ensureTarget(msg.requestId);
        if (!t.keyRotEl) {
          t.keyRotEl = document.createElement('div');
          t.keyRotEl.className = 'notice notice-key';
          t.tools.appendChild(t.keyRotEl);
        }
        t.keyRotEl.textContent = `⟳ Key ${msg.keyIndex}/${msg.keyTotal} · ${msg.platformName}`;
        t.keyRotEl.title = `Rate-limited on key ${msg.keyIndex - 1}; rotated to key ${msg.keyIndex} of ${msg.keyTotal} for ${msg.platformName}`;
        scrollDown();
        break;
      }
      case 'sessionTitle': {
        if (msg.sessionId && viewedSessionId && msg.sessionId !== viewedSessionId) break;
        const v = msg.title || '';
        lastTitle = v;
        // Don't clobber the field while the user is actively editing it.
        if (document.activeElement !== titleInput) titleInput.value = v;
        break;
      }
      case 'commandApproval': {
        const t = ensureTarget(msg.requestId);
        const card = document.createElement('div'); card.className = 'cmd-approval';
        const head = document.createElement('div'); head.className = 'cmd-approval-head';
        head.textContent = 'Run this command?';
        const pre = document.createElement('pre'); pre.className = 'cmd-approval-cmd';
        const code = document.createElement('code'); code.textContent = msg.command; pre.appendChild(code);
        card.appendChild(head); card.appendChild(pre);
        if (msg.cwd) { const cwd = document.createElement('div'); cwd.className = 'cmd-approval-cwd'; cwd.textContent = 'in ' + msg.cwd; card.appendChild(cwd); }
        const actions = document.createElement('div'); actions.className = 'cmd-approval-actions';
        const run = document.createElement('button'); run.className = 'primary'; run.textContent = 'Run';
        const skip = document.createElement('button'); skip.className = 'secondary'; skip.textContent = 'Skip';
        const decide = (approved) => {
          run.disabled = skip.disabled = true;
          actions.remove();
          const note = document.createElement('div');
          note.className = 'cmd-approval-note';
          note.textContent = approved ? '✓ Approved' : '✗ Skipped';
          card.appendChild(note);
          vscode.postMessage({ type: 'commandApprovalResponse', id: msg.id, approved, sessionId: msg.sessionId });
        };
        run.addEventListener('click', () => decide(true));
        skip.addEventListener('click', () => decide(false));
        actions.appendChild(run); actions.appendChild(skip);
        card.appendChild(actions);
        t.tools.appendChild(card);
        scrollDown();
        break;
      }
      case 'editApproval': {
        const t = ensureTarget(msg.requestId);
        const del = msg.kind === 'delete';
        const card = document.createElement('div'); card.className = 'cmd-approval';
        const head = document.createElement('div'); head.className = 'cmd-approval-head';
        head.textContent = msg.title || (del ? 'Delete this file?' : 'Apply these changes?');
        const pre = document.createElement('pre'); pre.className = 'cmd-approval-cmd';
        const code = document.createElement('code'); code.textContent = msg.path; pre.appendChild(code);
        const hint = document.createElement('div'); hint.className = 'cmd-approval-cwd';
        hint.textContent = del ? 'Deletes the file from the workspace.' : 'Review the diff in the editor, then apply or reject.';
        card.appendChild(head); card.appendChild(pre); card.appendChild(hint);
        const actions = document.createElement('div'); actions.className = 'cmd-approval-actions';
        const ok = document.createElement('button'); ok.className = 'primary'; ok.textContent = del ? 'Delete' : 'Apply';
        const no = document.createElement('button'); no.className = 'secondary'; no.textContent = del ? 'Keep' : 'Reject';
        const decide = (approved) => {
          ok.disabled = no.disabled = true;
          actions.remove();
          const note = document.createElement('div');
          note.className = 'cmd-approval-note';
          note.textContent = approved ? (del ? '✓ Deleted' : '✓ Applied') : (del ? '✗ Kept' : '✗ Rejected');
          card.appendChild(note);
          vscode.postMessage({ type: 'editApprovalResponse', id: msg.id, approved, sessionId: msg.sessionId });
        };
        ok.addEventListener('click', () => decide(true));
        no.addEventListener('click', () => decide(false));
        actions.appendChild(ok); actions.appendChild(no);
        card.appendChild(actions);
        t.tools.appendChild(card);
        scrollDown();
        break;
      }
      case 'planProposed': {
        const t = ensureTarget(msg.requestId);
        stopStatusTimer(msg.requestId, true);
        finalizeWork(msg.requestId);
        t.body.innerHTML = '';
        const head = document.createElement('div'); head.className = 'plan-head'; head.textContent = 'Proposed plan';
        t.body.appendChild(head);
        // A replayed or already-decided card (session switch, kept after Discard/Keep-discussing) —
        // show a read-only checklist, no edit controls, no action row.
        const settled = !!(msg.discarded || msg.deferred);
        const listEl = renderPlanChecklist(parsePlanSteps(msg.steps), !settled);
        t.body.appendChild(listEl);
        if (settled) { scrollDown(); break; }
        const collect = () => collectPlanSteps(listEl);
        const actions = document.createElement('div'); actions.className = 'plan-actions';
        const approve = document.createElement('button'); approve.className = 'primary'; approve.textContent = 'Approve & Run';
        const discuss = document.createElement('button'); discuss.className = 'secondary'; discuss.textContent = 'Keep discussing';
        const reject = document.createElement('button'); reject.className = 'secondary'; reject.textContent = 'Discard';
        approve.addEventListener('click', () => { actions.remove(); vscode.postMessage({ type: 'approvePlan', requestId: newId(), approved: true, steps: collect() }); });
        reject.addEventListener('click', () => { actions.remove(); vscode.postMessage({ type: 'approvePlan', requestId: newId(), approved: false, steps: collect() }); });
        discuss.addEventListener('click', () => {
          // Release the gate but keep the plan (and "Approve & Run") around to build later.
          discuss.remove(); reject.remove();
          const note = document.createElement('div'); note.className = 'plan-note';
          note.textContent = '💬 Kept for discussion — refine the steps above or the saved plan file, then Approve & Run when ready.';
          t.body.appendChild(note);
          vscode.postMessage({ type: 'deferPlan', requestId: msg.requestId, steps: collect() });
        });
        actions.appendChild(approve); actions.appendChild(discuss); actions.appendChild(reject);
        t.body.appendChild(actions);
        scrollDown();
        break;
      }
      case 'planDiscarded': {
        // The host rejected this plan — append a "✗ Discarded" note under the matching
        // plan body so the rejected plan stays in the transcript.
        for (const t of targets.values()) {
          if (t.requestId === msg.requestId) {
            const note = document.createElement('div'); note.className = 'plan-discarded';
            note.textContent = '✗ Discarded';
            t.body.appendChild(note);
            scrollDown();
            break;
          }
        }
        break;
      }
      case 'askUserPrompt': {
        const t = ensureTarget(msg.requestId);
        stopStatusTimer(msg.requestId, true);
        finalizeWork(msg.requestId);
        t.body.innerHTML = '';
        const card = document.createElement('div'); card.className = 'ask-card';
        card.dataset.callId = msg.callId;
        const intro = document.createElement('div'); intro.className = 'ask-intro';
        intro.textContent = 'The agent has a quick question:';
        const q = document.createElement('div'); q.className = 'ask-q-text'; q.textContent = msg.question;
        card.appendChild(intro); card.appendChild(q);
        const hasOptions = Array.isArray(msg.options) && msg.options.length >= 2;
        let answer = '';
        if (hasOptions) {
          const opts = document.createElement('div'); opts.className = 'ask-opts';
          msg.options.forEach((opt) => {
            const b = document.createElement('button'); b.type = 'button';
            b.className = 'ask-opt'; b.textContent = opt;
            b.addEventListener('click', () => { submit(opt); });
            opts.appendChild(b);
          });
          card.appendChild(opts);
        } else {
          const input = document.createElement('textarea'); input.className = 'ask-input';
          input.rows = 3; input.placeholder = 'Type your answer…';
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(input.value); }
          });
          const submitBtn = document.createElement('button'); submitBtn.type = 'button';
          submitBtn.className = 'primary'; submitBtn.textContent = 'Submit';
          submitBtn.addEventListener('click', () => submit(input.value));
          card.appendChild(input); card.appendChild(submitBtn);
          setTimeout(() => input.focus(), 0);
        }
        const submit = (text) => {
          answer = (text || '').trim() || '(no answer)';
          card.querySelectorAll('button, textarea').forEach((el) => { el.disabled = true; });
          const note = document.createElement('div'); note.className = 'ask-answer';
          note.textContent = '✓ ' + answer;
          card.appendChild(note);
          vscode.postMessage({ type: 'askUserResponse', requestId: msg.requestId, callId: msg.callId, answer });
        };
        t.body.appendChild(card);
        scrollDown();
        break;
      }
      case 'askUserDismissed': {
        // The host drained this in-flight askUser (e.g. user cancelled or started a new turn).
        // Find the matching card in the DOM and disable it so it can't be submitted.
        thread.querySelectorAll('.ask-card').forEach((card) => {
          if (card.dataset.callId === msg.callId) {
            card.querySelectorAll('button, textarea').forEach((el) => { el.disabled = true; });
            const note = document.createElement('div'); note.className = 'ask-answer';
            note.textContent = '— skipped —';
            card.appendChild(note);
          }
        });
        break;
      }
      case 'clarifyingQuestions': {
        const t = ensureTarget(msg.requestId);
        stopStatusTimer(msg.requestId, true);
        finalizeWork(msg.requestId);
        t.body.innerHTML = '';
        const qs = msg.questions;
        const selected = qs.map(() => null); // chosen option index per question; q.options.length === "type your own"
        const custom = qs.map(() => '');      // free-text answer per question, used when "type your own" is chosen
        let cur = 0;

        const card = document.createElement('div'); card.className = 'clarify';
        const intro = document.createElement('div'); intro.className = 'clarify-intro';
        intro.textContent = 'A couple of quick questions before I plan:';
        const tabsEl = document.createElement('div'); tabsEl.className = 'clarify-tabs';
        const qbox = document.createElement('div'); qbox.className = 'clarify-step';
        const nav = document.createElement('div'); nav.className = 'clarify-nav';
        const back = document.createElement('button'); back.type = 'button'; back.className = 'secondary'; back.textContent = 'Back';
        const next = document.createElement('button'); next.type = 'button'; next.className = 'primary'; next.textContent = 'Next →';
        nav.appendChild(back); nav.appendChild(next);
        const meta = document.createElement('div'); meta.className = 'clarify-meta';
        const metaCount = document.createElement('span'); metaCount.className = 'clarify-meta-count';
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'clarify-dismiss'; dismiss.textContent = 'Dismiss';
        meta.appendChild(metaCount); meta.appendChild(document.createTextNode(' · ')); meta.appendChild(dismiss);
        const footer = document.createElement('div'); footer.className = 'clarify-footer';
        footer.appendChild(nav); footer.appendChild(meta);
        card.appendChild(intro); card.appendChild(tabsEl); card.appendChild(qbox); card.appendChild(footer);

        const CUSTOM = (qi) => qs[qi].options.length; // pseudo-index for the "type your own" row
        const answered = (qi) => selected[qi] !== null && (selected[qi] !== CUSTOM(qi) || custom[qi].trim().length > 0);
        const isLast = () => cur === qs.length - 1;
        const allAnswered = () => qs.every((q, qi) => answered(qi));
        function updateNav() {
          back.disabled = cur === 0;
          metaCount.textContent = `${cur + 1}/${qs.length}`;
          if (isLast()) { next.textContent = 'Submit answers'; next.disabled = !allAnswered(); }
          else { next.textContent = 'Next →'; next.disabled = !answered(cur); }
        }
        function renderTabs() {
          tabsEl.innerHTML = '';
          qs.forEach((q, i) => {
            const tb = document.createElement('button'); tb.type = 'button';
            tb.className = 'clarify-tab' + (i === cur ? ' active' : '') + (answered(i) ? ' done' : '');
            tb.textContent = q.label || `Q${i + 1}`;
            tb.title = q.text;
            tb.addEventListener('click', () => { cur = i; renderStep(); });
            tabsEl.appendChild(tb);
          });
        }
        function choose(oi) {
          selected[cur] = oi;
          renderStep();
          // Auto-advance only for a concrete option — the free-text row needs the user to type first.
          if (oi !== CUSTOM(cur) && !isLast()) setTimeout(() => { cur++; renderStep(); }, 180);
        }
        function renderStep() {
          renderTabs();
          qbox.innerHTML = '';
          const q = qs[cur];
          const counter = document.createElement('div'); counter.className = 'clarify-counter';
          counter.textContent = q.label ? `${q.label} · Question ${cur + 1} of ${qs.length}` : `Question ${cur + 1} of ${qs.length}`;
          const qt = document.createElement('div'); qt.className = 'clarify-q-text'; qt.textContent = q.text;
          const opts = document.createElement('div'); opts.className = 'clarify-opts';
          const mkRow = (oi, title, desc) => {
            const row = document.createElement('button'); row.type = 'button';
            row.className = 'clarify-opt' + (selected[cur] === oi ? ' selected' : '');
            const num = document.createElement('span'); num.className = 'clarify-opt-num'; num.textContent = `${oi + 1}.`;
            const radio = document.createElement('span'); radio.className = 'clarify-radio';
            const body = document.createElement('span'); body.className = 'clarify-opt-body';
            const tEl = document.createElement('span'); tEl.className = 'clarify-opt-title'; tEl.textContent = title; body.appendChild(tEl);
            if (desc) { const dEl = document.createElement('span'); dEl.className = 'clarify-opt-desc'; dEl.textContent = desc; body.appendChild(dEl); }
            row.appendChild(num); row.appendChild(radio); row.appendChild(body);
            row.addEventListener('click', () => choose(oi));
            opts.appendChild(row);
          };
          q.options.forEach((opt, oi) => mkRow(oi, opt.title, opt.description));
          mkRow(CUSTOM(cur), 'Type your own answer', '');
          // Reveal a free-text input when the "type your own" row is the current selection.
          if (selected[cur] === CUSTOM(cur)) {
            const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'clarify-custom';
            inp.placeholder = 'Type your answer…'; inp.value = custom[cur];
            inp.addEventListener('input', () => { custom[cur] = inp.value; updateNav(); renderTabs(); });
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next.click(); } });
            opts.appendChild(inp);
            setTimeout(() => inp.focus(), 0);
          }
          qbox.appendChild(counter); qbox.appendChild(qt); qbox.appendChild(opts);
          updateNav();
          scrollDown();
        }
        back.addEventListener('click', () => { if (cur > 0) { cur--; renderStep(); } });
        next.addEventListener('click', () => {
          if (!isLast()) { if (answered(cur)) { cur++; renderStep(); } return; }
          if (!allAnswered()) return;
          card.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
          const answers = qs.map((q, qi) => selected[qi] === CUSTOM(qi) ? custom[qi].trim() : q.options[selected[qi]].title);
          vscode.postMessage({ type: 'answerClarifying', requestId: msg.requestId, answers });
        });
        dismiss.addEventListener('click', () => {
          card.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
          const note = document.createElement('div'); note.className = 'clarify-counter'; note.textContent = '✗ Dismissed — planning with sensible defaults.';
          card.appendChild(note);
          // Let the planner proceed on its own best judgment for every question.
          const answers = qs.map(() => '(no preference — use your best judgment)');
          vscode.postMessage({ type: 'answerClarifying', requestId: msg.requestId, answers });
        });

        renderStep();
        t.body.appendChild(card);
        scrollDown();
        break;
      }
      case 'assistantChunk': {
        // Live streaming token — append to the buffer and re-render markdown incrementally.
        // We throttle DOM updates to every 40ms (one rAF cycle) so a fast model doesn't
        // cause layout thrash on every token. The buffer is flushed fully on assistantMessage.
        const t = ensureTarget(msg.requestId);
        t._streamBuf = (t._streamBuf || '') + msg.text;
        t._wasStreamed = true;
        if (!t._streamPending) {
          t._streamPending = true;
          requestAnimationFrame(() => {
            t._streamPending = false;
            if (!t._streamBuf) return;
            t.body.innerHTML = '';
            t.body.appendChild(renderMarkdown(t._streamBuf));
            scrollDown();
          });
        }
        break;
      }
      case 'assistantMessage': {
        const t = ensureTarget(msg.requestId);
        // Clear the streaming buffer — assistantMessage carries the authoritative full text.
        t._streamBuf = '';
        t._streamPending = false;
        stopStatusTimer(msg.requestId, true);
        // Add a fold-up 💭 Reasoning disclosure only when no live 🧠 Thinking block already
        // captured this reasoning inline — otherwise the same reasoning would show twice.
        if (msg.reasoning && !t.tools.querySelector('.think-block')) {
          const det = document.createElement('details'); det.className = 'reasoning';
          det.innerHTML = `<summary>Reasoning</summary>`;
          det.appendChild(renderMarkdown(msg.reasoning));
          t.tools.insertBefore(det, t.tools.firstChild); // inside the "Worked for Ns" disclosure
        }
        // Finalize the work summary (reveals it as "Worked for Ns", collapsed).
        finalizeWork(msg.requestId);
        t.el._copyText = msg.text;
        // If chunks already streamed the text live, skip typeInto — the body already shows
        // the full content and re-animating it would flash/clear what the user is reading.
        // Only use typeInto when no streaming happened (non-streaming models / tool turns).
        if (t._wasStreamed) {
          t._wasStreamed = false;
          t.body.innerHTML = '';
          t.body.appendChild(renderMarkdown(msg.text));
        } else {
          typeInto(t.body, msg.text);
        }
        // The final message carries the model that actually answered — use it as
        // the source of truth so the footer never blanks (e.g. when a forced model
        // failed over before assistantStart could set t.model).
        if (msg.model) t.model = `${msg.platform || ''}/${msg.model}`;
        let usageStr = '';
        if (msg.usage) usageStr = `  ·  ${fmtUsage(msg.usage)}`;
        const startedAt = t.startedAt ?? startTimes.get(msg.requestId);
        const secs = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null;
        const durStr = secs != null ? `  ·  ${secs}s` : '';
        t.el.appendChild(assistantFooter(t.el, (t.model || '') + usageStr + durStr, Date.now(), msg.requestId));
        // The run stopped before finishing (step cap or a model dropping out). Offer a
        // one-click resume — it picks up with full memory, so no work is repeated.
        if (msg.paused) {
          const resume = document.createElement('div'); resume.className = 'resume-actions';
          const btn = document.createElement('button'); btn.className = 'primary'; btn.textContent = 'Continue';
          btn.title = 'Resume from where the agent stopped — keeps everything it has done so far';
          btn.addEventListener('click', () => { resume.remove(); vscode.postMessage({ type: 'resume', requestId: newId() }); });
          resume.appendChild(btn);
          t.el.appendChild(resume);
        }
        scrollDown();
        break;
      }
      case 'usageTotals':
        updateFooter(msg.totals);
        renderUsageStatsCard(msg.totals && msg.totals.lifetime);
        break;
      case 'indexProgress':
        renderIndexStatus(msg);
        break;
      case 'checkpoint':
        renderCheckpoint(msg);
        break;
      case 'changedFiles':
        renderChangedBar(msg);
        break;
      case 'attachmentAdded':
        pendingAttachments.push(msg.attachment);
        renderChips();
        break;
      case 'mentionResults':
        if (acMode === 'mention' && msg.queryId === acQueryId) {
          (msg.items && msg.items.length) ? renderAc(msg.items) : closeAc();
        }
        break;
      case 'mcpRegistryResults':
        if (msg.queryId === mcpSearchId && mcpResultsEl) {
          if (msg.error) mcpResultsEl.innerHTML = '<div class="error">Registry search failed: ' + escapeHtml(msg.error) + '</div>';
          else renderMcpItems(msg.items || []);
        }
        break;
      case 'notice': {
        clearEmpty();
        const d = document.createElement('div');
        d.className = 'compact-divider';
        d.textContent = msg.text;
        (currentTurn || thread).appendChild(d);
        scrollDown();
        break;
      }
      case 'error': {
        const t = msg.requestId ? ensureTarget(msg.requestId) : null;
        if (msg.requestId) stopStatusTimer(msg.requestId, true);
        if (msg.requestId) finalizeWork(msg.requestId);
        const el = document.createElement('div'); el.className = 'bubble error';
        el.textContent = '⚠ ' + msg.message;
        (t ? t.body : currentTurn || thread).appendChild(el);
        scrollDown();
        break;
      }
      case 'busy': {
        busy = msg.busy;
        const sb = $('#btn-send');
        sb.innerHTML = busy ? ICON.stop : ICON.send;
        sb.title = busy ? 'Stop' : 'Send (Enter)';
        sb.classList.toggle('stopping', busy);
        // Backstop: any run that ended without a terminal message (e.g. plan mode's
        // early return) still flips busy off — clear any lingering live status then.
        if (!busy) for (const id of statusTimers.keys()) stopStatusTimer(id, true);
        break;
      }
      case 'clear':
        if (settingsOpen) toggleSettings();
        thread.innerHTML = '';
        currentTurn = null;
        targets.clear();
        userTargets.clear();
        statusTimers.forEach((id) => clearInterval(id));
        statusTimers.clear();
        renderChangedBar({ files: [] }); // drop the review bar with the cleared session
        renderEmpty();
        break;
    }
  });

  // Changed-files review under a command: lists what the agent edited since this
  // message (click a file to diff). Restoring is done via the message's ⟲ revert icon.
  const CP_STATUS = { created: 'A', modified: 'M', deleted: 'D' };
  function renderCheckpoint(msg) {
    const host = userTargets.get(msg.requestId) || (targets.get(msg.requestId) || {}).el;
    if (!host) return;
    let bar = host.querySelector(':scope > .checkpoint');
    const files = msg.files || [];
    if (!files.length) { if (bar) bar.remove(); return; } // nothing changed here anymore
    if (!bar) { bar = document.createElement('div'); bar.className = 'checkpoint'; host.appendChild(bar); }
    bar.innerHTML = '';
    const head = document.createElement('details'); head.className = 'cp-d';
    const sum = document.createElement('summary');
    sum.textContent = `✎ ${files.length} file${files.length > 1 ? 's' : ''} changed`;
    head.appendChild(sum);
    const list = document.createElement('div'); list.className = 'cp-files';
    files.forEach((f) => {
      const row = document.createElement('div'); row.className = 'cp-file';
      const badge = document.createElement('span'); badge.className = 'cp-badge cp-' + f.status;
      badge.textContent = CP_STATUS[f.status] || '?'; badge.title = f.status;
      const name = document.createElement('span'); name.className = 'cp-name'; name.textContent = f.rel;
      row.appendChild(badge); row.appendChild(name);
      row.title = 'Open diff (before this message ↔ current)';
      row.addEventListener('click', () => vscode.postMessage({ type: 'diffCheckpointFile', id: msg.id, uri: f.uri }));
      list.appendChild(row);
    });
    head.appendChild(list);
    bar.appendChild(head);
  }

  // Live task checklist for a turn (TodoWrite-style). Rendered above the answer
  // bubble and updated in place as the agent advances each item. When `followingPlan`
  // is true (Plan → Agent handoff), prepend a small header so the user sees these
  // todos ARE the approved plan steps.
  function renderTodos(t, todos, followingPlan) {
    if (!todos.length) { if (t.todoEl) { t.todoEl.remove(); t.todoEl = null; } return; }
    if (!t.todoEl) { t.todoEl = document.createElement('div'); t.todoEl.className = 'todo-list'; t.el.insertBefore(t.todoEl, t.body); }
    t.todoEl.innerHTML = '';
    if (followingPlan) {
      const planHead = document.createElement('div'); planHead.className = 'todo-plan-head';
      planHead.textContent = 'Following the approved plan';
      t.todoEl.appendChild(planHead);
    }
    const done = todos.filter((x) => x.status === 'completed').length;
    const head = document.createElement('div'); head.className = 'todo-head';
    head.textContent = `Tasks · ${done}/${todos.length}`;
    t.todoEl.appendChild(head);
    todos.forEach((td) => {
      const row = document.createElement('div'); row.className = 'todo-item ' + td.status;
      const ic = document.createElement('span'); ic.className = 'todo-ic';
      if (td.status === 'in_progress') ic.innerHTML = '<span class="todo-spin"></span>';
      else ic.textContent = td.status === 'completed' ? '✓' : '○';
      const tx = document.createElement('span'); tx.className = 'todo-tx'; tx.textContent = td.content;
      row.appendChild(ic); row.appendChild(tx);
      t.todoEl.appendChild(row);
    });
    scrollDown();
  }

  // ── Structured, editable plan checklist (pre-approval) ───────────────────────────────
  // Parse plan text into discrete step strings (numbered/bulleted list lines); falls back to
  // the whole trimmed text as one step if the model didn't use a list.
  function parsePlanSteps(steps) {
    const items = [];
    for (const line of String(steps || '').split('\n')) {
      const mm = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
      if (mm) { const tx = mm[1].replace(/\*\*/g, '').trim(); if (tx) items.push(tx); }
    }
    if (!items.length) { const t = String(steps || '').trim(); if (t) items.push(t); }
    return items;
  }

  function addPlanRow(listEl, text, focus) {
    const row = document.createElement('div'); row.className = 'plan-row';
    const ic = document.createElement('span'); ic.className = 'plan-ic'; ic.textContent = '○';
    const tx = document.createElement('span'); tx.className = 'plan-tx'; tx.contentEditable = 'plaintext-only'; tx.textContent = text || '';
    tx.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addPlanRow(listEl, '', true); }
      else if (e.key === 'Backspace' && !tx.textContent && listEl.querySelectorAll('.plan-row').length > 1) {
        e.preventDefault();
        const prev = row.previousElementSibling; row.remove();
        const p = prev && prev.querySelector ? prev.querySelector('.plan-tx') : null; if (p) p.focus();
      }
    });
    const del = document.createElement('span'); del.className = 'plan-del'; del.textContent = '✕'; del.title = 'Remove step';
    del.addEventListener('click', () => { if (listEl.querySelectorAll('.plan-row').length > 1) row.remove(); });
    row.appendChild(ic); row.appendChild(tx); row.appendChild(del);
    const addBtn = listEl.querySelector('.plan-add');
    if (addBtn) listEl.insertBefore(row, addBtn); else listEl.appendChild(row);
    if (focus) tx.focus();
    return row;
  }

  function renderPlanChecklist(items, editable) {
    const listEl = document.createElement('div'); listEl.className = 'plan-list';
    if (editable) {
      const add = document.createElement('div'); add.className = 'plan-add'; add.textContent = '+ Add step';
      add.addEventListener('click', () => addPlanRow(listEl, '', true));
      listEl.appendChild(add);
      (items.length ? items : ['']).forEach((it) => addPlanRow(listEl, it, false));
    } else {
      items.forEach((it) => {
        const row = document.createElement('div'); row.className = 'plan-row';
        const ic = document.createElement('span'); ic.className = 'plan-ic'; ic.textContent = '○';
        const tx = document.createElement('span'); tx.className = 'plan-tx'; tx.textContent = it;
        row.appendChild(ic); row.appendChild(tx); listEl.appendChild(row);
      });
    }
    return listEl;
  }

  // Re-serialize the (possibly edited) rows back into a numbered list the host can parse.
  function collectPlanSteps(listEl) {
    const out = [];
    listEl.querySelectorAll('.plan-row .plan-tx').forEach((el) => { const t = (el.textContent || '').trim(); if (t) out.push(t); });
    return out.map((s, i) => `${i + 1}. ${s}`).join('\n');
  }

  // Pinned "changed files" review bar above the composer (Cursor/Kilo-style). Shows
  // every file edited this session; collapse the list, click a file to diff it, or
  // undo all the edits. Collapsed state persists across re-renders.
  let changedBarCollapsed = false;
  function renderChangedBar(msg) {
    const bar = $('#changed-bar');
    if (!bar) return;
    const files = (msg && msg.files) || [];
    if (!files.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.innerHTML = '';
    bar.classList.toggle('collapsed', changedBarCollapsed);
    const head = document.createElement('div'); head.className = 'cb-head';
    const chevron = document.createElement('button'); chevron.className = 'cb-chevron';
    chevron.innerHTML = ICON.chevron; chevron.title = changedBarCollapsed ? 'Expand' : 'Collapse';
    const title = document.createElement('span'); title.className = 'cb-title';
    title.textContent = `✎ ${files.length} changed`;
    const toggle = () => {
      changedBarCollapsed = !changedBarCollapsed;
      bar.classList.toggle('collapsed', changedBarCollapsed);
      chevron.title = changedBarCollapsed ? 'Expand' : 'Collapse';
    };
    chevron.addEventListener('click', toggle);
    title.addEventListener('click', toggle); title.style.cursor = 'pointer';
    const undo = document.createElement('button'); undo.className = 'cb-action';
    undo.textContent = 'Undo all'; undo.title = 'Restore all changed files to before this session’s edits';
    undo.addEventListener('click', () => vscode.postMessage({ type: 'restoreCheckpoint', id: msg.id }));
    const close = document.createElement('button'); close.className = 'cb-close'; close.textContent = '×';
    close.title = 'Hide (reappears on the next change)';
    close.addEventListener('click', () => { bar.classList.add('hidden'); });
    head.appendChild(chevron); head.appendChild(title); head.appendChild(undo); head.appendChild(close);
    const list = document.createElement('div'); list.className = 'cb-files';
    files.forEach((f) => {
      const chip = document.createElement('button'); chip.className = 'cb-file';
      const badge = document.createElement('span'); badge.className = 'cb-badge cp-' + f.status;
      badge.textContent = CP_STATUS[f.status] || '?';
      const name = document.createElement('span'); name.className = 'cb-name';
      name.textContent = f.rel.split('/').pop();
      chip.title = `${f.rel} — open diff`;
      chip.appendChild(badge); chip.appendChild(name);
      chip.addEventListener('click', () => vscode.postMessage({ type: 'diffCheckpointFile', id: msg.id, uri: f.uri }));
      list.appendChild(chip);
    });
    bar.appendChild(head); bar.appendChild(list);
    bar.classList.remove('hidden');
  }

  // Transient codebase-index status: shown only while building, hidden when full.
  function renderIndexStatus(p) {
    const el = $('#index-status');
    if (!el) return;
    if (!p || !p.building) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const label = p.phase === 'scanning'
      ? 'Scanning workspace…'
      : `Indexing codebase… ${p.done}/${p.total} (${pct}%)`;
    el.classList.remove('hidden');
    el.innerHTML = '<span class="idx-spinner"></span><span class="idx-label"></span><span class="idx-bar"><span class="idx-fill"></span></span>';
    el.querySelector('.idx-label').textContent = label;
    el.querySelector('.idx-fill').style.width = pct + '%';
  }

  function updateFooter(totals) {
    if (!totals) return;
    const session = totals.requests
      ? `Session: ${totals.requests} req · ${fmtTokens(totals.totalTokens)} tokens`
      : 'No tokens used yet.';
    let ctx = '';
    if (totals.context && totals.context.window) {
      const t = totals.context.tokens, w = totals.context.window;
      const pct = Math.min(100, Math.round((t / w) * 100));
      const kw = w >= 1000 ? Math.round(w / 1000) + 'k' : w;
      ctx = `  ·  ctx ~${t}/${kw} (${pct}%)`;
    }
    let lifetime = '';
    if (totals.lifetime && (totals.lifetime.totalTokens > 0 || totals.lifetime.estimatedSavingsUsd > 0)) {
      const lt = totals.lifetime;
      lifetime = `  ·  Lifetime: ${fmtTokens(lt.totalTokens)} tokens · est. ${fmtUsd(lt.estimatedSavingsUsd)} saved`;
    }
    $('#footer').textContent = session + ctx + lifetime;
  }

  // Render the "Usage data" card inside the Others tab. Safe to call before
  // the user opens the tab — looks up the element by id and bails if missing.
  let lastLifetime = { totalTokens: 0, totalRequests: 0, estimatedSavingsUsd: 0 };
  function renderUsageStatsCard(lifetime) {
    if (lifetime) lastLifetime = lifetime;
    const el = document.getElementById('usage-stats-card');
    if (!el) return;
    const lt = lastLifetime;
    el.innerHTML = '';
    const row = (label, value) => {
      const r = document.createElement('div'); r.className = 'usage-stat-row';
      const l = document.createElement('span'); l.className = 'usage-stat-label'; l.textContent = label;
      const v = document.createElement('span'); v.className = 'usage-stat-value'; v.textContent = value;
      r.append(l, v);
      el.appendChild(r);
    };
    row('Total tokens', fmtTokens(lt.totalTokens || 0));
    row('Total requests', String(lt.totalRequests || 0));
    row('Est. $ saved', fmtUsd(lt.estimatedSavingsUsd || 0));
    // Reset the clear button label if it was in "Clearing…" state.
    const btn = document.getElementById('usage-clear-btn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Clear usage data';
    }
  }

  renderEmpty();
  vscode.postMessage({ type: 'ready' });
})();
