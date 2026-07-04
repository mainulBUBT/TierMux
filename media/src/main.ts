// TODO(Phase D): this file is a verbatim conversion of the legacy media/main.js
// and is not yet typechecked. It is migrated incrementally — extract a section,
// remove this directive for that section's errors, fix them, repeat. Until then
// `@ts-nocheck` keeps the build green while NEW modules (./icons, ./format) are
// fully strict-checked. Do NOT let this marker spread to other files.
//
// @ts-nocheck
/* TierMux — webview controller (vanilla TS, bundled by esbuild). */
import { ICON } from './icons';
import { fmtTime, fmtTokens, fmtCompact, fmtUsage, fmtUsd, fmtSessionDate } from './format';
import { send } from './bridge';
import type { RxMessage } from './bridge';
import { $, escapeHtml, showToast } from './dom';
import { renderMarkdown } from './markdown';
import { buildReasoningBlock, buildToolCard, toolLabel, activityFor } from './toolRendering';

(function () {
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
  // renderMarkdown + configureMarked live in ./markdown (strict-checked).
  // (The legacy typeInto() was removed: it had zero callers — dead code carried
  // over from the original main.js.)

  // ---------- icons + formatting helpers ----------
  // ICON and the fmt* helpers live in ./icons and ./format (stateless modules).

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
      <div class="footer footer-clickable" id="footer" role="button" tabindex="0" title="Open Usage settings">No usage yet</div>
    </div>
    </div>`;

  const thread = $('#thread');
  const railEl = null; // replaced by history dropdown
  const historyDropdown = $('#history-dropdown');
  const historySearch = $('#history-search');
  const historyList = $('#history-list');
  const settingsEl = $('#settings');
  const composer = $('#composer');
  const footerEl = $('#footer');
  // Footer summary → Settings ▸ Usage. Opens settings (if closed) and switches
  // tab without reloading/recreating the webview, then scrolls the
  // already-rendered usage card into view.
  function goToUsageSettings() {
    settingsTab = 'usage';
    if (!settingsOpen) {
      settingsOpen = true;
      settingsEl.classList.add('active');
      thread.classList.add('hidden');
      composer.classList.add('hidden');
    }
    renderSettings();
    requestAnimationFrame(() => {
      document.getElementById('usage-data-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  footerEl.addEventListener('click', goToUsageSettings);
  footerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToUsageSettings(); }
  });
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
    send({ type: 'setAutoApprove', enabled: autoApprove });
  });

  // Chat header: brand + editable session title (rename inline, Enter to save).
  const titleInput = $('#chat-title');
  let lastTitle = '';
  function commitTitle() {
    const v = (titleInput.value || '').trim();
    if (v && v !== lastTitle) { lastTitle = v; send({ type: 'renameSession', title: v }); }
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

  // showToast lives in ./dom (stateless, strict-checked).

  // ---------- session history dropdown ----------
  const STATUS_DOT = { idle: '●', queued: '⏳', running: '⟳', needsApproval: '!', finished: '✓' };
  const STATUS_TITLE = {
    idle: 'Idle', queued: 'Queued', running: 'Running',
    needsApproval: 'Needs your approval', finished: 'Finished',
  };

  let historyOpen = false;
  let historyQuery = '';
  // Tracks which history session row is expanded. Declared explicitly because
  // the original sloppy-mode JS assigned it without `let` (a silent global);
  // the bundled output runs in strict mode (it's an ES module), where that
  // would throw ReferenceError and kill the history dropdown.
  let expandedHistoryId = null;

  function toggleHistory(force) {
    historyOpen = typeof force === 'boolean' ? force : !historyOpen;
    if (historyOpen) {
      historyDropdown.classList.remove('hidden');
      historySearch.value = '';
      historyQuery = '';
      expandedHistoryId = null;
      renderTabs();
      historySearch.focus();
    } else {
      expandedHistoryId = null;
      historyDropdown.classList.add('hidden');
    }
  }

  historySearch.addEventListener('input', () => {
    historyQuery = historySearch.value.toLowerCase();
    renderTabs();
  });
  historySearch.addEventListener('click', (e) => e.stopPropagation());
  historyDropdown.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (historyOpen && !historyDropdown.contains(e.target)) toggleHistory(false);
  });

  // Delegated handler — one listener, survives every renderTabs() re-render.
  historyList.addEventListener('click', (e) => {
    const target = e.target;
    // Delete button — must check before row so click on trash doesn't also switch session
    const delEl = target.closest('[data-delete-id]');
    if (delEl) {
      e.stopPropagation();
      const sid = delEl.dataset.deleteId;
      if (sid) {
        // Optimistic removal — don't wait for backend sessionList refresh
        const row = delEl.closest('[data-session-id]');
        if (row) row.remove();
        sessionList = sessionList.filter(s => s.id !== sid);
        if (!historyList.querySelector('.history-item')) {
          const empty = document.createElement('div');
          empty.className = 'history-empty';
          empty.textContent = 'No sessions yet';
          historyList.appendChild(empty);
        }
        send({ type: 'deleteSessionById', sessionId: sid });
      }
      return;
    }
    // Row click → switch session and close
    const row = target.closest('[data-session-id]');
    if (row) {
      const sid = row.dataset.sessionId;
      if (sid && sid !== viewedSessionId) send({ type: 'switchSession', sessionId: sid });
      toggleHistory(false);
    }
  });

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
      const item = document.createElement('div');
      item.className = 'history-item' + (s.id === viewedSessionId ? ' active' : '') + (' status-' + (s.status || 'idle'));
      item.dataset.sessionId = s.id;
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
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
      const delBtn = document.createElement('span');
      delBtn.className = 'history-delete-btn';
      delBtn.title = 'Delete session';
      delBtn.setAttribute('role', 'button');
      delBtn.dataset.deleteId = s.id;
      delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M6 2h4v1H6V2zm-2 2v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4H4zm2 2h1v5H6V6zm3 0h1v5H9V6zM1 3h14v1H1V3z"/></svg>';
      item.appendChild(left);
      item.appendChild(ts);
      item.appendChild(delBtn);
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

    const recents = sessionList.filter(s => s.id !== viewedSessionId).slice(0, 5);
    const recentHtml = recents.length ? `
      <div class="empty-recents">
        <div class="empty-recents-header">
          <div class="empty-recents-label">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1H2V3zm0 3h12v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6zm3 2a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5zm0 2a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H5z"/></svg>
            RECENT
          </div>
          <button class="empty-view-all" id="empty-view-all-btn">View All ›</button>
        </div>
        ${recents.map(s => `
          <div class="empty-recent-card" data-id="${s.id}">
            <div class="empty-card-title">${s.title || 'Untitled'}</div>
            <div class="empty-card-meta">
              <span class="empty-card-date">${fmtTs(s.updatedAt || s.ts)}</span>
              <span class="empty-card-cost">$0.00</span>
            </div>
          </div>`).join('')}
      </div>` : '';

    const logoHtml = window.__LOGO_URI__
      ? `<img class="empty-logo-img" src="${window.__LOGO_URI__}" alt="TierMux" onerror="this.style.display='none'" />`
      : `<div class="empty-logo">⚡</div>`;

    el.innerHTML = `
      <div class="empty-hero">
        ${logoHtml}
        <div class="empty-heading">Stack free. Route smart. Ship faster.</div>
      </div>
      ${recentHtml}`;

    el.querySelectorAll('.empty-recent-card').forEach(card => {
      card.addEventListener('click', () => {
        send({ type: 'switchSession', sessionId: card.dataset.id });
      });
    });
    const viewAllBtn = el.querySelector('#empty-view-all-btn');
    if (viewAllBtn) viewAllBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHistory(true); });
    thread.appendChild(el);
  }

  function fmtTs(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const diffMs = now - d, diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
      send({ type: 'copyText', text: el._copyText || '' });
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
      if (requestId) send({ type: 'vote', requestId, vote: now });
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
    if (requestId) meta.appendChild(iconBtn(ICON.revert, 'Revert to here (restore workspace + chat to before this message)', () => send({ type: 'revertTo', requestId })));
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
    const hasReasoning = !!details.reasoning && !steps.some((s) => s.name === 'reasoning');

    // Chronological flow — same visual as live agent runs (Phase 1b).
    const flow = document.createElement('div'); flow.className = 'flow';

    // Reasoning block goes first (it preceded the work, like in live runs).
    if (hasReasoning) {
      const det = document.createElement('details'); det.className = 'think-block';
      det.innerHTML = `<summary>Reasoning</summary>`;
      det.appendChild(renderMarkdown(details.reasoning));
      flow.appendChild(det);
    }

    // Tool cards and text segments interleaved in recorded step order.
    // Each step is either a tool card or (for reasoning-named steps) a think-block.
    steps.forEach((step) => {
      if (step.name === 'reasoning' && step.content) {
        const det = document.createElement('details'); det.className = 'think-block';
        det.innerHTML = `<summary>Reasoning</summary>`;
        det.appendChild(renderMarkdown(step.content));
        flow.appendChild(det);
      } else {
        flow.appendChild(buildToolCard(step));
      }
    });

    // Main answer text at the end (matches live: text segment appended after tool cards).
    if (text) {
      const seg = document.createElement('div'); seg.className = 'flow-text bubble';
      seg.appendChild(renderMarkdown(text));
      flow.appendChild(seg);
    }

    // Only attach flow if it has children (pure-text ask-mode: just the text seg).
    if (flow.children.length) el.appendChild(flow);

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
    // Chronological "flow": tool cards, reasoning blocks, and streamed text segments append
    // here in the order events arrive (professional agent timeline, like Cursor/Copilot/OC).
    // `tools` aliases the flow so existing tool/failover/reasoning code keeps working.
    const flow = document.createElement('div'); flow.className = 'flow';
    const statusEl = document.createElement('div');
    statusEl.className = 'agent-status';
    statusEl.innerHTML = `<span class="agent-dots"><span></span><span></span><span></span></span><span class="agent-label"></span><span class="agent-caret">▍</span><span class="agent-elapsed"></span>`;
    // `bubble` stays AFTER the flow for interactive cards (approvals/plans/clarify) and the
    // non-streamed final answer — keeping those paths untouched.
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    // statusEl sits AFTER the flow so the live "Working." indicator appears at the END of
    // the activity feed (below tool cards / streaming text), matching Antigravity — not as a
    // header above. It's hidden on completion by stopStatusTimer(); the flow then collapses
    // into the "Worked for Ns ▼" summary.
    el.appendChild(flow);
    el.appendChild(statusEl);
    el.appendChild(bubble);
    (currentTurn || thread).appendChild(el);
    const modelStr = model ? `${platform || ''}/${model}` : '';
    t = { el, body: bubble, tools: flow, flow, currentText: null, statusEl, statusLabel: statusEl.querySelector('.agent-label'), statusCaret: statusEl.querySelector('.agent-caret'), statusElapsed: statusEl.querySelector('.agent-elapsed'), toolRunning: false, activeTool: null, model: modelStr, requestId };
    targets.set(requestId, t);
    scrollDown();
    return t;
  }

  // ---------- live "agent is working" status line ----------
  // Keep the last two segments of a path so absolute workspace paths stay tidy.
  // Strip the clarifying-questions sentinel block (and any stray sentinels) from text
  // BEFORE rendering, so `???QUESTIONS???` / `???END???` never flash in the chat while
  // the plan streams. The parsed questions surface as an interactive card at turn end.
  // Tolerant of `??? QUESTIONS ???`, wrong case, or missing ? — matches the host parser.
  // While the block is still streaming (QUESTIONS seen, END not yet), hides everything
  // from the QUESTIONS sentinel onward so the raw question text doesn't show either.
  function stripClarifyBlock(s) {
    const sm = /\?{2,}\s*QUESTIONS\s*\?{2,}/i.exec(s);
    if (sm) {
      const rest = s.slice(sm.index + sm[0].length);
      const em = /\?{2,}\s*END\s*\?{2,}/i.exec(rest);
      const tail = em ? rest.slice(em.index + em[0].length) : '';
      s = s.slice(0, sm.index) + tail;
    }
    return s.replace(/\?{2,}\s*(?:QUESTIONS|END)\s*\?{2,}/gi, '');
  }
  // Present-tense "what the agent is doing right now" for the rolling status label.
  // (The tool CARDS in the feed use the past-tense toolLabel() — "Analyzed/Searched…".
  //  This is the live verb shown beside the spinner, Claude-Code-style.)
  // Whimsical rolling verbs for the thinking phase (Claude-Code-style): while the
  // agent is "working" but no concrete tool verb or streaming response applies, the
  // spinner cycles through these so the status feels alive instead of a static word.
  // Whimsical rolling verbs for the thinking phase (Claude-Code-style). Stored as
  // lowercase bases and capitalized on display so the list is easy to scan/edit.
  // Mix of "real" thinking words and silly ones to keep it playful.
  const THINKING_VERBS = [
    'cogitating', 'pondering', 'mulling', 'ruminating', 'deliberating', 'meditating',
    'cerebrating', 'contemplating', 'reflecting',
    'reasoning', 'thinking', 'weighing', 'puzzling', 'untangling', 'deciphering', 'decoding',
    'parsing', 'calculating', 'computing', 'crunching', 'processing', 'percolating', 'marinating',
    'simmering', 'stewing', 'steeping', 'brewing', 'distilling', 'fermenting', 'cooking', 'baking',
    'stitching', 'weaving', 'knitting', 'folding', 'spinning', 'forging', 'crafting', 'shaping',
    'polishing', 'sanding', 'tinkering', 'fiddling', 'toying', 'wrangling', 'herding', 'juggling',
    'conjuring', 'summoning', 'divining', 'channeling', 'crystallizing', 'synthesizing',
    'orchestrating', 'scheming', 'dreaming', 'noodling', 'booping', 'combobulating', 'typing',
    'writing', 'doodling', 'scribbling', 'sketching',
  ];
  // Labels that mean "idle thinking" — when one of these is set, we engage the rolling
  // verb instead of showing the literal word. Tool verbs and "Responding…" opt out.
  const IDLE_LABELS = new Set(['Thinking…', 'Working…', 'Working.', 'Reasoning…']);
  // Random gap between verb rotations, 2–5s, so the rolling word doesn't feel metronomic.
  function nextRotateDelay() { return 2000 + Math.floor(Math.random() * 3001); }
  // Pick a whimsical verb different from the previous one (avoids the same word twice
  // in a row, which reads like a frozen label). `prevDisplay` is the last shown "Verb…".
  function pickThinkingVerb(prevDisplay) {
    const prev = String(prevDisplay || '').toLowerCase().replace(/…$/, '');
    let base = prev, guard = 0;
    while (base === prev && guard++ < 8) base = THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
    return base.charAt(0).toUpperCase() + base.slice(1) + '…';
  }
  // Type a verb out one character at a time with a trailing cursor, so the live label
  // reads like the assistant is *writing* the word right now. Cancels any in-flight type
  // on the same target first. Holds the full word (cursor still blinking via CSS) once done.
  function typeVerb(requestId, fullVerb) {
    const t = targets.get(requestId);
    if (!t || !t.statusLabel) return;
    if (t._typeTimer) { clearInterval(t._typeTimer); t._typeTimer = null; }
    const speed = 45; // ms per character — brisk but legible
    let i = 0;
    const reveal = () => {
      i++;
      t.statusLabel.textContent = fullVerb.slice(0, i);
      if (i >= fullVerb.length) { clearInterval(t._typeTimer); t._typeTimer = null; }
    };
    reveal(); // first char immediately so it never looks empty
    t._typeTimer = setInterval(reveal, speed);
  }
  // Set the rolling status label. While a tool is running, only that tool's own updates
  // (opts.tool) or a terminal revert (opts.done) may change the label — stray reasoning
  // deltas / text chunks must NOT clobber the live tool verb. Returns true if it wrote.
  function setStatusLabel(requestId, text, opts) {
    const t = targets.get(requestId);
    if (!t || !t.statusLabel) return false;
    opts = opts || {};
    if (t.toolRunning && !opts.force && !opts.tool && !opts.done) return false;
    if (opts.tool) t.toolRunning = true;
    if (opts.done) t.toolRunning = false;
    if (text != null) {
      if (IDLE_LABELS.has(text)) {
        // Engage the rolling whimsical verb for the thinking phase; startStatusTimer
        // rotates it every 2–5s until a tool verb or "Responding…" takes over. The verb
        // is typed out char-by-char with a blinking caret so it reads like live writing.
        t.rotating = true;
        t.rotateWord = pickThinkingVerb(t.rotateWord);
        t.nextRotateAt = Date.now() + nextRotateDelay();
        if (t.statusCaret) t.statusCaret.classList.remove('hidden');
        typeVerb(requestId, t.rotateWord);
      } else {
        t.rotating = false;
        if (t._typeTimer) { clearInterval(t._typeTimer); t._typeTimer = null; }
        if (t.statusCaret) t.statusCaret.classList.add('hidden');
        t.statusLabel.textContent = text;
      }
    }
    return true;
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
      // Roll the whimsical thinking verb on a random 2–5s cadence while in the
      // thinking phase and no tool is running (a running tool owns the label via
      // its own activity verb).
      if (t.rotating && !t.toolRunning && Date.now() >= (t.nextRotateAt || 0)) {
        t.rotateWord = pickThinkingVerb(t.rotateWord);
        t.nextRotateAt = Date.now() + nextRotateDelay();
        typeVerb(requestId, t.rotateWord);
      }
    };
    update();
    statusTimers.set(requestId, setInterval(update, 500));
  }
  function stopStatusTimer(requestId, hide) {
    const id = statusTimers.get(requestId);
    if (id) { clearInterval(id); statusTimers.delete(requestId); }
    const t = targets.get(requestId);
    if (t?._typeTimer) { clearInterval(t._typeTimer); t._typeTimer = null; }
    if (hide) {
      if (t && t.statusEl) t.statusEl.classList.add('hidden');
    }
  }
  // Finalize a turn's flow. Wraps all tool cards and think-blocks into a collapsed
  // <details> summary so the final answer is immediately visible after the run ends.
  // Text segments (.flow-text) stay outside so the answer is never hidden.
  function finalizeWork(requestId) {
    const t = targets.get(requestId);
    if (!t) return;
    t.currentText = null;
    if (!t.flow) return;

    // Drop empty text segments — multiple tool calls each reset currentText, leaving
    // blank .flow-text divs in the flow that create visual whitespace.
    Array.from(t.flow.children)
      .filter((el) => el.classList.contains('flow-text') && !el.textContent.trim())
      .forEach((el) => el.remove());

    if (t.flow.children.length === 0) { t.flow.remove(); return; }

    const workNodes = Array.from(t.flow.children).filter(
      (el) => el.classList.contains('tool-card') || el.classList.contains('think-block')
    );
    if (!workNodes.length) return;

    const toolCount = workNodes.filter((el) => el.classList.contains('tool-card')).length;
    const thinkCount = workNodes.filter((el) => el.classList.contains('think-block')).length;
    const elapsed = t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : null;
    const parts = [];
    if (elapsed != null) parts.push(`Worked for ${elapsed}s`);
    if (toolCount) parts.push(`${toolCount} tool use${toolCount !== 1 ? 's' : ''}`);
    if (thinkCount && !toolCount) parts.push(`${thinkCount} thought${thinkCount !== 1 ? 's' : ''}`);

    const det = document.createElement('details');
    det.className = 'work-summary';
    const sum = document.createElement('summary');
    sum.className = 'work-sum-label';
    sum.textContent = parts.join('  ·  ') || 'Worked';
    det.appendChild(sum);

    t.flow.insertBefore(det, workNodes[0]);
    workNodes.forEach((n) => det.appendChild(n));
    // Chat: collapse each tool step's output inside the summary so expanding the summary
    // shows compact steps (icon + label + status), each individually expandable on click.
    // Agent/plan are left as-is (fully expanded for transparency).
    if (currentMode === 'chat') {
      det.querySelectorAll('.tool-more').forEach((m) => { m.open = false; });
    }
    scrollDown();
  }

  function submitChat() {
    if (busy) { send({ type: 'cancel', requestId: 'current', sessionId: viewedSessionId }); return; }
    const text = input.value.trim();
    if (!text && pendingAttachments.length === 0) return;
    const requestId = newId();
    // Send a preview of pending visual attachments in the user bubble so the user
    // sees what they attached (data URLs only — the host keeps the canonical copy).
    const previews = pendingAttachments
      .filter((a) => a.kind === 'image' && a.dataUrl)
      .map((a) => ({ kind: 'image', name: a.name, dataUrl: a.dataUrl }));
    addUserBubble(text, requestId, Date.now(), pendingAttachments.map((a) => ({ kind: a.kind, name: a.name, dataUrl: a.dataUrl })));
    send({
      type: 'sendMessage', requestId, text,
      mode: currentMode, model: currentModel, reasoningEffort: reasoningSel.value,
      attachments: pendingAttachments,
      attachmentKinds: pendingAttachments.map((a) => a.kind),
    });
    input.value = '';
    autoGrow(); // reset the textarea back to one line after sending (don't leave it stuck tall)
    pendingAttachments = [];
    renderChips();
    updateSendEnabled();
  }

  $('#btn-send').addEventListener('click', submitChat);
  input.addEventListener('keydown', (e) => {
    if (!acPop.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAc(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitChat(); }
  });
  input.addEventListener('input', () => { autoGrow(); updateAutocomplete(); updateSendEnabled(); });
  input.addEventListener('click', updateAutocomplete);
  input.addEventListener('blur', () => setTimeout(closeAc, 120));
  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }
  // Disable the send button when there's nothing to send (no text and no attachments).
  // While busy it becomes the Stop button, which must stay clickable.
  function updateSendEnabled() {
    const sb = $('#btn-send');
    if (busy) { sb.disabled = false; return; }
    sb.disabled = input.value.trim().length === 0 && pendingAttachments.length === 0;
  }

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
    reasoningSel.value = c ? c.reasoning : 'off';
    updateReasoningAvailability();
    pendingAttachments = c && c.attachments ? c.attachments.slice() : [];
    renderChips();
    autoGrow();
    updateSendEnabled();
  }
  // Persist the draft as the user types, so a background switch never loses it.
  input.addEventListener('input', () => { if (viewedSessionId) saveComposer(viewedSessionId); });

  $('#btn-attach').addEventListener('click', () => send({ type: 'attachFromWorkspace' }));
  $('#btn-selection').addEventListener('click', () => send({ type: 'addSelection' }));
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
      send({ type: 'attachFromDataUrl', name: file.name, mime: file.type || mime, dataUrl, source });
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
    updateSendEnabled();
  }

  // escapeHtml lives in ./dom (stateless, strict-checked).

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
    // Custom endpoint models use platform='custom' which may not be in activePlatforms,
    // so they won't appear in `enabled`. Build a separate set so a user's custom-endpoint
    // selection isn't silently wiped on every config refresh.
    const customEnabled = new Set(
      (state.fallback || []).filter((e) => e.platform === 'custom' && e.enabled).map((e) => `custom::${e.modelId}`)
    );
    // If the selected model was unchecked/removed, fall back to Auto.
    if (currentModel !== 'auto' && !enabled.has(currentModel) && !customEnabled.has(currentModel)) currentModel = 'auto';
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
      acDebounce = setTimeout(() => send({ type: 'mentionQuery', queryId: id, query: q }), 150);
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
      // Slash items' own label already starts with '/' (e.g. "/explain") — no separate icon,
      // or it renders as a redundant double slash ("/ /explain").
      const icon = it.kind === 'folder' ? '📁' : it.kind === 'symbol' ? '◈' : it.kind === 'slash' ? '' : '📄';
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
    const isValidation = msg.name === 'runCommand' && /\b(tsc|eslint|prettier|lint|typecheck|check|jest|vitest|mocha|pytest|go\s+test|cargo\s+(check|test)|npm\s+test|yarn\s+test|pnpm\s+test)\b/.test(
      String(msg.args && typeof msg.args === 'object' ? (msg.args.command ?? JSON.stringify(msg.args)) : msg.args || '')
    );
    let cls = 'tool-card state-' + msg.state;
    if (isValidation) cls += ' validation';
    card.className = cls;
    card.dataset.tc = msg.toolCallId;
    const more = card.querySelector('.tool-more');
    const pre = more.querySelector('pre');
    const isEdit = msg.name === 'editFile' || msg.name === 'writeFile' || msg.name === 'createFile';
    const editArgs = isEdit && msg.args && typeof msg.args === 'object' ? msg.args : null;
    if (editArgs && editArgs.old_string != null && editArgs.new_string != null) {
      // Inline diff for patch-style edits
      pre.textContent = '';
      pre.className = 'diff-view';
      pre.appendChild(buildInlineDiff(editArgs.old_string, editArgs.new_string));
      more.classList.remove('hidden');
      if (msg.state === 'done' && currentMode !== 'chat') more.open = true;
    } else if (msg.detail) {
      pre.className = '';
      pre.textContent = msg.detail;
      more.classList.remove('hidden');
      // Always expand when done — CSS max-height keeps it from taking over the screen.
      // While running, expand so partial output streams in visibly.
      // Chat mode stays compact (collapsed): the answer is the focus, not the tool log —
      // the user can click any step to expand it. Agent/plan keep the verbose live view.
      if (currentMode !== 'chat') more.open = true;
    } else {
      more.classList.add('hidden');
    }
    // Validation result: add pass/fail attribute when done so CSS can colour it
    if (isValidation && msg.state === 'done') {
      const exitMatch = String(msg.detail || '').match(/exit\s*(?:code\s*)?(\d+)/i);
      const failed = exitMatch ? exitMatch[1] !== '0' : /error|fail/i.test(String(msg.detail || ''));
      card.setAttribute('data-val-result', failed ? 'fail' : 'pass');
    }
    scrollDown();
  }

  /** Build a simple before/after diff fragment for inline edit display. */
  // ---------- settings panel ----------
  let settingsOpen = false;
  // Custom-endpoint model discovery: epId -> { loading?, models?: string[], error?: string }.
  // Populated by the 'customEndpointModels' host reply; read while rendering each endpoint card.
  const fetchedEndpointModels = new Map();
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
  // MCP Add/Edit form state: null = closed, '' = new server, or the name being edited.
  let mcpFormOpenFor = null;
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
    if (settingsTab === 'others' || settingsTab === 'usage') search.style.display = 'none';
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
    [['providers', 'Providers'], ['mcp', 'MCP'], ['usage', 'Usage'], ['others', 'Others']].forEach((pair) => {
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
    else if (settingsTab === 'mcp') renderMcpSection();
    else if (settingsTab === 'usage') renderUsageSection();
    else renderOthersSection();
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
      item.addEventListener('click', () => send({ type: 'setUtilityModel', model: value }));
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
  }

  // "Usage" tab: lifetime token/request/savings totals (persisted across
  // reloads) plus retrieval-quality diagnostics. Its own top-level nav tab so
  // it's reachable directly from the settings nav and from the footer's
  // click-through (see goToUsageSettings).
  function renderUsageSection() {
    const usageWrap = document.createElement('div');
    usageWrap.className = 'usage-data-section';
    usageWrap.id = 'usage-data-section';
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
      // Confirmation happens on the extension host (see the clearUsage handler) —
      // window.confirm() is blocked inside VS Code webviews, so it must NOT be used here.
      usageClear.disabled = true;
      usageClear.textContent = 'Clearing…';
      send({ type: 'clearUsage' });
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

    // Changing routing config while an agent is mid-run can strand it on a disabled
    // model/provider — so any toggle here cancels the active turn first.
    const stopIfBusy = () => {
      if (busy) send({ type: 'cancel', requestId: 'current', sessionId: viewedSessionId });
    };

    // Global master toggle — flip every provider's on/off switch at once (same
    // mechanism as each provider card's switch, just applied to all of them).
    // Disabling all providers mid-run strands the active agent on dead routing, so
    // when an LLM is actively working we also cancel the running turn.
    const toggleablePlatforms = state.platforms.filter((p) => p.platform !== 'custom');
    const disabledSet = new Set(state.disabledProviders || []);
    const allProvidersOn = toggleablePlatforms.length > 0 && toggleablePlatforms.every((p) => !disabledSet.has(p.platform));
    const anyProviderOn = toggleablePlatforms.some((p) => !disabledSet.has(p.platform));
    const allBar = document.createElement('div');
    allBar.className = 'pm-all-bar';
    const allText = document.createElement('span');
    allText.className = 'pm-all-text';
    allText.textContent = 'All providers';
    const allLabel = document.createElement('label');
    allLabel.className = 'prov-switch';
    allLabel.title = 'Enable or disable every provider at once';
    const allCb = document.createElement('input');
    allCb.type = 'checkbox';
    allCb.checked = allProvidersOn;
    allCb.indeterminate = !allProvidersOn && anyProviderOn;
    const allTrack = document.createElement('span');
    allTrack.className = 'sw-track';
    const allThumb = document.createElement('span');
    allThumb.className = 'sw-thumb';
    allTrack.appendChild(allThumb);
    allLabel.appendChild(allCb);
    allLabel.appendChild(allTrack);
    allBar.appendChild(allText);
    allBar.appendChild(allLabel);
    allCb.addEventListener('change', () => {
      const on = allCb.checked;
      toggleablePlatforms.forEach((p) => {
        send({ type: 'setProviderEnabled', platform: p.platform, enabled: on });
      });
      stopIfBusy();
    });
    settingsContentEl.appendChild(allBar);

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
        send({ type: 'setProviderEnabled', platform: p.platform, enabled: swCb.checked });
        stopIfBusy();
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
          send(keyCount > 0 ? { type: 'addKey', platform: p.platform } : { type: 'setKey', platform: p.platform });
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
        send({ type: 'setEndpoint', platform: p.platform, url });
      });
      const resetEp = document.createElement('button');
      resetEp.className = 'icon-btn';
      resetEp.textContent = 'Reset';
      resetEp.addEventListener('click', () => { epInput.value = ''; send({ type: 'resetEndpoint', platform: p.platform }); });
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
                send({ type: 'removeKeyAt', platform: p.platform, index: idx });
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
      const modelCbs = []; // individual model checkboxes, for the bulk toggle to sync
      let allModelCb = null; // per-provider "all models" checkbox (created when there are models)
      if (models.length) {
        const mt = document.createElement('div');
        mt.className = 'prov-models-head';
        const mtLabel = document.createElement('span');
        mtLabel.className = 'muted prov-models-title';
        mtLabel.textContent = isProviderDisabled ? 'Models (provider off — not routing)' : 'Models';
        mt.appendChild(mtLabel);

        // Per-provider bulk toggle — check / uncheck every model for this provider.
        allModelCb = document.createElement('input');
        allModelCb.type = 'checkbox';
        allModelCb.className = 'prov-models-all';
        allModelCb.title = 'Toggle all models for this provider';
        allModelCb.checked = models.every((e) => e.enabled);
        allModelCb.indeterminate = !allModelCb.checked && models.some((e) => e.enabled);
        allModelCb.addEventListener('change', () => {
          const on = allModelCb.checked;
          models.forEach((e, i) => { e.enabled = on; if (modelCbs[i]) modelCbs[i].checked = on; });
          allModelCb.indeterminate = false;
          send({ type: 'setFallbackConfig', entries });
          stopIfBusy();
        });
        mt.appendChild(allModelCb);
        body.appendChild(mt);
      }
      models.forEach((e) => {
        const m = cat[e.platform + '::' + e.modelId] || {};
        const caps = [];
        if (m.supportsTools) caps.push('T');
        if (m.supportsVision) caps.push('V');
        if (m.supportsReasoning) caps.push('R');
        // Row is a <label> so clicking the model name / meta toggles the checkbox,
        // not just the small box itself. Mutate the entry by reference (not by
        // findIndex, which can resolve to the wrong entry when a model has a
        // duplicate fallback row — that made the second row's checkbox a no-op).
        const row = document.createElement('label');
        row.className = 'pm-row';
        if (isProviderDisabled) row.style.opacity = '.4';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!e.enabled;
        cb.addEventListener('change', () => {
          e.enabled = cb.checked;
          send({ type: 'setFallbackConfig', entries });
          // Keep the bulk toggle in sync with the individual rows.
          if (allModelCb) {
            allModelCb.checked = models.every((x) => x.enabled);
            allModelCb.indeterminate = !allModelCb.checked && models.some((x) => x.enabled);
          }
          stopIfBusy();
        });
        modelCbs.push(cb);
        const info = document.createElement('div');
        info.className = 'pm-info';
        info.innerHTML = `<div class="pm-name">${escapeHtml(m.displayName || e.modelId)}</div>
          <div class="meta">ctx ${m.contextWindow ? fmtTokens(m.contextWindow) : '?'} · ${escapeHtml(m.sizeLabel || '')} · ${escapeHtml(m.monthlyTokenBudget || '')}</div>`;
        const capsEl = document.createElement('div');
        capsEl.className = 'caps';
        capsEl.innerHTML = caps.map((c) => `<span class="cap" title="${c === 'T' ? 'tools' : c === 'V' ? 'vision' : 'reasoning'}">${c}</span>`).join('');
        row.appendChild(cb);
        row.appendChild(info);
        row.appendChild(capsEl);
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
        send({ type: 'addCustomEndpoint', name, baseUrl: url });
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
            send({ type: 'updateCustomEndpoint', id: ep.id, name: newName });
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
          send({ type: 'updateCustomEndpoint', id: ep.id, baseUrl: url });
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
            send({ type: 'setCustomEndpointKey', id: ep.id, key: (res[0] || '').trim() });
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
            send({ type: 'setCustomEndpointKey', id: ep.id, key: null });
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
          cb.addEventListener('change', () => { entries[idx].enabled = cb.checked; send({ type: 'setFallbackConfig', entries }); });
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
              send({ type: 'removeCustomModel', endpointId: ep.id, modelId: upstreamId });
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
          send({ type: 'addCustomModel', endpointId: ep.id, modelId });
        });
        addModelRow.appendChild(addModelBtn);

        // Fetch-models button — discover the endpoint's catalog from <baseUrl>/models and
        // render a clickable list (Kilo/Cline-style), instead of typing every ID by hand.
        const discovery = fetchedEndpointModels.get(ep.id);
        const fetchBtn = document.createElement('button');
        fetchBtn.className = 'secondary';
        fetchBtn.style.marginLeft = '8px';
        fetchBtn.textContent = discovery && discovery.loading ? 'Fetching…' : '⟳ Fetch models from API';
        fetchBtn.disabled = !!(discovery && discovery.loading);
        fetchBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          fetchedEndpointModels.set(ep.id, { loading: true });
          send({ type: 'fetchCustomEndpointModels', id: ep.id });
          renderSettings();
        });
        addModelRow.appendChild(fetchBtn);
        body.appendChild(addModelRow);

        // Discovered-models list (clickable chips). Only the IDs not already added are shown.
        if (discovery && !discovery.loading) {
          const wrap = document.createElement('div');
          wrap.style.marginTop = '8px';
          if (discovery.error) {
            wrap.className = 'muted';
            wrap.style.color = 'var(--vscode-errorForeground)';
            wrap.textContent = 'Could not fetch models: ' + discovery.error;
          } else {
            const added = new Set(epModels.map((e) => e.modelId.split('::').slice(1).join('::')));
            const fresh = (discovery.models || []).filter((id) => !added.has(id));
            if (!discovery.models || discovery.models.length === 0) {
              wrap.className = 'muted';
              wrap.textContent = 'The endpoint returned no models.';
            } else if (fresh.length === 0) {
              wrap.className = 'muted';
              wrap.textContent = 'All ' + discovery.models.length + ' models from this endpoint are already added.';
            } else {
              const label = document.createElement('div');
              label.className = 'muted';
              label.style.marginBottom = '6px';
              label.textContent = 'Click to add (' + fresh.length + ' available):';
              wrap.appendChild(label);
              const chips = document.createElement('div');
              chips.className = 'model-chip-row';
              chips.style.display = 'flex';
              chips.style.flexWrap = 'wrap';
              chips.style.gap = '6px';
              fresh.forEach((id) => {
                const chip = document.createElement('button');
                chip.className = 'secondary model-chip';
                chip.textContent = '+ ' + id;
                chip.title = 'Add ' + id;
                chip.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  send({ type: 'addCustomModel', endpointId: ep.id, modelId: id });
                  chip.disabled = true;
                  chip.textContent = '✓ ' + id;
                });
                chips.appendChild(chip);
              });
              wrap.appendChild(chips);
              if (fresh.length > 1) {
                const addAll = document.createElement('button');
                addAll.className = 'secondary';
                addAll.style.marginTop = '8px';
                addAll.textContent = 'Add all ' + fresh.length;
                addAll.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  fresh.forEach((id) => send({ type: 'addCustomModel', endpointId: ep.id, modelId: id }));
                  addAll.disabled = true;
                  addAll.textContent = '✓ Added';
                });
                wrap.appendChild(addAll);
              }
            }
          }
          body.appendChild(wrap);
        }

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
            send({ type: 'removeCustomEndpoint', id: ep.id });
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

  function renderMcpSection() {
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'MCP Servers';
    settingsContentEl.appendChild(title);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Tools from configured MCP servers are available to the agent (OpenCode connects to them directly).';
    settingsContentEl.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.style.margin = '6px 0';
    const addBtn = document.createElement('button');
    addBtn.className = 'secondary';
    addBtn.textContent = '+ Add server';
    addBtn.addEventListener('click', () => { mcpFormOpenFor = ''; renderSettings(); });
    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.textContent = 'Edit in settings.json';
    editBtn.addEventListener('click', () => send({ type: 'editMcp' }));
    const reBtn = document.createElement('button');
    reBtn.className = 'icon-btn';
    reBtn.textContent = '⟳ Reconnect';
    reBtn.addEventListener('click', () => send({ type: 'reconnectMcp' }));
    actions.appendChild(addBtn);
    actions.appendChild(editBtn);
    actions.appendChild(reBtn);
    settingsContentEl.appendChild(actions);

    if (mcpFormOpenFor === '') renderMcpForm(null);

    const servers = state.mcp || [];
    if (!servers.length && mcpFormOpenFor === null) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.textContent = 'No MCP servers configured yet — add one below.';
      settingsContentEl.appendChild(none);
    }
    servers.forEach((s) => {
      const raw = (state.mcpServers || {})[s.name];
      if (mcpFormOpenFor === s.name) { renderMcpForm(s.name); return; }
      const card = document.createElement('div');
      card.className = 'provider-card';
      const enabled = !raw || raw.enabled !== false;
      const dot = !enabled ? 'missing' : s.status === 'connected' ? 'healthy' : s.status === 'error' ? 'invalid' : 'missing';
      const head = document.createElement('div');
      head.className = 'provider-head';
      const typeLabel = raw ? (raw.type === 'remote' ? 'remote' : 'local') : '';
      head.innerHTML = `<span class="status-dot status-${dot}"></span><span class="provider-name">${escapeHtml(s.name)}</span><span class="muted prov-status">${typeLabel}${typeLabel ? ' · ' : ''}${!enabled ? 'disabled' : s.status === 'connected' ? s.toolCount + ' tools' : escapeHtml(s.status)}</span>`;
      const enableCb = document.createElement('input');
      enableCb.type = 'checkbox';
      enableCb.title = 'Enabled';
      enableCb.checked = enabled;
      enableCb.style.marginLeft = 'auto';
      enableCb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        send({ type: 'setMcpServerEnabled', name: s.name, enabled: enableCb.checked });
      });
      head.appendChild(enableCb);
      const editSrvBtn = document.createElement('button');
      editSrvBtn.className = 'icon-btn';
      editSrvBtn.textContent = '✎';
      editSrvBtn.title = 'Edit server';
      editSrvBtn.addEventListener('click', (ev) => { ev.stopPropagation(); mcpFormOpenFor = s.name; renderSettings(); });
      head.appendChild(editSrvBtn);
      const rm = document.createElement('button');
      rm.className = 'icon-btn';
      rm.textContent = '✕';
      rm.title = 'Remove server';
      rm.addEventListener('click', (ev) => { ev.stopPropagation(); send({ type: 'removeMcpServer', name: s.name }); });
      head.appendChild(rm);
      const chev = document.createElement('span');
      chev.className = 'chev';
      chev.style.marginLeft = '0'; // the buttons already claim the gap
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
    mt.textContent = 'Add from registry';
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
      mcpSearchTimer = setTimeout(() => send({ type: 'searchMcpRegistry', queryId: id, query: q }), 350);
    });
  }

  // Parses one KEY=VALUE (env) or Key: Value (headers) pair per non-empty line.
  function parsePairLines(text, sep) {
    const out = {};
    (text || '').split('\n').forEach((line) => {
      const t = line.trim();
      if (!t) return;
      const i = t.indexOf(sep);
      if (i <= 0) return;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + sep.length).trim();
      if (k) out[k] = v;
    });
    return out;
  }
  function pairsToLines(obj, sep) {
    return Object.entries(obj || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');
  }

  /** Add/Edit form for a native-schema MCP server. `existingName` is null for a new
   *  server, or the name of the server being edited (config pre-filled from
   *  `state.mcpServers[existingName]`). Local vs Remote maps 1:1 to OpenCode's own
   *  McpLocalConfig / McpRemoteConfig — no TierMux-specific fields are added. */
  function renderMcpForm(existingName) {
    const raw = existingName ? (state.mcpServers || {})[existingName] : null;
    const isRemote = raw ? raw.type === 'remote' : false;

    const card = document.createElement('div');
    card.className = 'provider-card mcp-form';
    const title = document.createElement('div');
    title.className = 'others-title';
    title.textContent = existingName ? `Edit "${existingName}"` : 'New MCP server';
    card.appendChild(title);

    const err = document.createElement('div');
    err.className = 'error hidden';
    card.appendChild(err);

    const field = (labelText, input) => {
      const row = document.createElement('div');
      row.className = 'pm-row';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';
      const lbl = document.createElement('label');
      lbl.className = 'muted';
      lbl.textContent = labelText;
      row.appendChild(lbl);
      row.appendChild(input);
      card.appendChild(row);
      return input;
    };

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = existingName || '';
    nameInput.placeholder = 'e.g. filesystem';
    field('Name', nameInput);

    // Type selector
    const typeRow = document.createElement('div');
    typeRow.className = 'pm-row';
    const localLabel = document.createElement('label');
    const localRadio = document.createElement('input');
    localRadio.type = 'radio'; localRadio.name = 'mcp-type'; localRadio.checked = !isRemote;
    localLabel.appendChild(localRadio); localLabel.append(' Local (stdio)');
    const remoteLabel = document.createElement('label');
    const remoteRadio = document.createElement('input');
    remoteRadio.type = 'radio'; remoteRadio.name = 'mcp-type'; remoteRadio.checked = isRemote;
    remoteLabel.appendChild(remoteRadio); remoteLabel.append(' Remote');
    remoteLabel.style.marginLeft = '16px';
    typeRow.appendChild(localLabel);
    typeRow.appendChild(remoteLabel);
    card.appendChild(typeRow);

    // ---- Local fields ----
    const localBox = document.createElement('div');
    const commandInput = document.createElement('input');
    commandInput.type = 'text';
    commandInput.placeholder = 'npx';
    commandInput.value = !isRemote && raw && raw.command ? raw.command[0] || '' : '';
    const mkField = (parent, labelText, input) => {
      const row = document.createElement('div');
      row.className = 'pm-row';
      row.style.flexDirection = 'column';
      row.style.alignItems = 'stretch';
      const lbl = document.createElement('label');
      lbl.className = 'muted';
      lbl.textContent = labelText;
      row.appendChild(lbl);
      row.appendChild(input);
      parent.appendChild(row);
      return input;
    };
    mkField(localBox, 'Command (executable)', commandInput);
    const argsInput = document.createElement('textarea');
    argsInput.rows = 3;
    argsInput.placeholder = 'one argument per line';
    argsInput.value = !isRemote && raw && raw.command ? raw.command.slice(1).join('\n') : '';
    mkField(localBox, 'Arguments', argsInput);
    const envInput = document.createElement('textarea');
    envInput.rows = 3;
    envInput.placeholder = 'KEY=value (one per line)';
    envInput.value = !isRemote && raw ? pairsToLines(raw.environment, '=') : '';
    mkField(localBox, 'Environment variables', envInput);
    const cwdInput = document.createElement('input');
    cwdInput.type = 'text';
    cwdInput.placeholder = 'defaults to the workspace root';
    cwdInput.value = (!isRemote && raw && raw.cwd) || '';
    mkField(localBox, 'Working directory (optional)', cwdInput);
    card.appendChild(localBox);

    // ---- Remote fields ----
    const remoteBox = document.createElement('div');
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://example.com/mcp';
    urlInput.value = (isRemote && raw && raw.url) || '';
    mkField(remoteBox, 'URL', urlInput);
    const headersInput = document.createElement('textarea');
    headersInput.rows = 3;
    headersInput.placeholder = 'Header-Name: value (one per line)';
    headersInput.value = isRemote && raw ? pairsToLines(raw.headers, ': ') : '';
    mkField(remoteBox, 'Headers', headersInput);

    const oauthSel = document.createElement('select');
    [['auto', 'Auto-detect (default)'], ['disabled', 'Disabled'], ['custom', 'Custom…']].forEach(([v, lbl]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = lbl; oauthSel.appendChild(o);
    });
    const existingOauth = isRemote && raw ? raw.oauth : undefined;
    oauthSel.value = existingOauth === false ? 'disabled' : existingOauth && typeof existingOauth === 'object' ? 'custom' : 'auto';
    mkField(remoteBox, 'OAuth configuration', oauthSel);
    const oauthBox = document.createElement('div');
    const oc = existingOauth && typeof existingOauth === 'object' ? existingOauth : {};
    const oClientId = document.createElement('input'); oClientId.type = 'text'; oClientId.value = oc.clientId || '';
    const oClientSecret = document.createElement('input'); oClientSecret.type = 'password'; oClientSecret.value = oc.clientSecret || '';
    const oRedirect = document.createElement('input'); oRedirect.type = 'text'; oRedirect.value = oc.redirectUri || '';
    const oScope = document.createElement('input'); oScope.type = 'text'; oScope.value = oc.scope || '';
    const oPort = document.createElement('input'); oPort.type = 'number'; oPort.value = oc.callbackPort || '';
    mkField(oauthBox, 'Client ID', oClientId);
    mkField(oauthBox, 'Client secret', oClientSecret);
    mkField(oauthBox, 'Redirect URI', oRedirect);
    mkField(oauthBox, 'Scope', oScope);
    mkField(oauthBox, 'Callback port', oPort);
    remoteBox.appendChild(oauthBox);
    card.appendChild(remoteBox);

    const syncType = () => {
      localBox.classList.toggle('hidden', remoteRadio.checked);
      remoteBox.classList.toggle('hidden', !remoteRadio.checked);
      oauthBox.classList.toggle('hidden', oauthSel.value !== 'custom');
    };
    localRadio.addEventListener('change', syncType);
    remoteRadio.addEventListener('change', syncType);
    oauthSel.addEventListener('change', syncType);
    syncType();

    // ---- Common fields ----
    const timeoutInput = document.createElement('input');
    timeoutInput.type = 'number';
    timeoutInput.placeholder = 'ms — blank uses OpenCode\'s default';
    timeoutInput.value = (raw && raw.timeout) || '';
    field('Timeout (ms, optional)', timeoutInput);

    const enabledRow = document.createElement('label');
    enabledRow.className = 'pm-row';
    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    enabledCb.checked = !raw || raw.enabled !== false;
    enabledRow.appendChild(enabledCb);
    enabledRow.append(' Enabled');
    card.appendChild(enabledRow);

    // ---- Save / Cancel ----
    const btnRow = document.createElement('div');
    btnRow.className = 'row-actions';
    btnRow.style.marginTop = '8px';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'secondary';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      err.classList.add('hidden');
      const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
      if (!name) return fail('Name is required.');
      let config;
      if (remoteRadio.checked) {
        const url = urlInput.value.trim();
        if (!url) return fail('URL is required for a remote server.');
        config = {
          type: 'remote',
          url,
          enabled: enabledCb.checked,
        };
        const headers = parsePairLines(headersInput.value, ':');
        if (Object.keys(headers).length) config.headers = headers;
        if (oauthSel.value === 'disabled') config.oauth = false;
        else if (oauthSel.value === 'custom') {
          const oauth = {};
          if (oClientId.value.trim()) oauth.clientId = oClientId.value.trim();
          if (oClientSecret.value.trim()) oauth.clientSecret = oClientSecret.value.trim();
          if (oRedirect.value.trim()) oauth.redirectUri = oRedirect.value.trim();
          if (oScope.value.trim()) oauth.scope = oScope.value.trim();
          if (oPort.value.trim()) oauth.callbackPort = Number(oPort.value.trim());
          config.oauth = oauth;
        }
      } else {
        const command = commandInput.value.trim();
        if (!command) return fail('Command is required for a local server.');
        const args = argsInput.value.split('\n').map((l) => l.trim()).filter(Boolean);
        config = {
          type: 'local',
          command: [command, ...args],
          enabled: enabledCb.checked,
        };
        const environment = parsePairLines(envInput.value, '=');
        if (Object.keys(environment).length) config.environment = environment;
        if (cwdInput.value.trim()) config.cwd = cwdInput.value.trim();
      }
      const timeout = timeoutInput.value.trim();
      if (timeout) config.timeout = Number(timeout);
      send({ type: 'saveMcpServer', name, originalName: existingName || undefined, config });
      mcpFormOpenFor = null;
      renderSettings();
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'icon-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => { mcpFormOpenFor = null; renderSettings(); });
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    card.appendChild(btnRow);

    settingsContentEl.appendChild(card);
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
      add.addEventListener('click', () => send({ type: 'addMcpServer', item }));
      row.appendChild(info);
      row.appendChild(add);
      mcpResultsEl.appendChild(row);
    });
  }

  // ---------- inbound messages ----------
  window.addEventListener('message', (event) => {
    const msg: RxMessage = event.data;
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
        renderUsageStatsCard(msg.usageTotals && msg.usageTotals.lifetime, msg.usageTotals && msg.usageTotals.retrieval);
        if (settingsOpen) renderSettings();
        break;
      case 'customEndpointModels':
        // Host finished discovering an endpoint's models — cache and re-render the card.
        fetchedEndpointModels.set(msg.id, { models: msg.models || [], error: msg.error });
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
        if (thread.querySelector('.empty')) renderEmpty();
        break;
      case 'setInput':
        input.value = msg.text || '';
        input.focus();
        autoGrow();
        // Programmatic value assignment doesn't fire the 'input' event, so recompute
        // the send button's disabled state — otherwise text sits in the box but Send
        // stays disabled (e.g. after a run finished with an empty composer).
        updateSendEnabled();
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
        // The model shows as a DIM SUBTITLE (friendly name from the picker, never the raw
        // provider key). The label itself is the rolling activity verb (Thinking…/Reading…/…).
        setStatusLabel(msg.requestId, 'Thinking…', { force: true });
        startStatusTimer(msg.requestId);
        break;
      }
      case 'agentStep': {
        const t = ensureTarget(msg.requestId);
        // An explicit OC status message wins; otherwise leave the current activity label.
        if (msg.label) setStatusLabel(msg.requestId, msg.label, { force: true });
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
        if (msg.state === 'running') {
          // Rolling status verb for the live tool (Reading X / Searching "q" / Running cmd…).
          t.activeTool = msg.toolCallId;
          setStatusLabel(msg.requestId, activityFor(msg.name, msg.args), { tool: true });
        } else if (msg.toolCallId && msg.toolCallId === t.activeTool) {
          // The running tool itself finished — release the lock and drop back to synthesizing.
          // (Reasoning/other 'done' events carry different ids and must not clobber a running tool.)
          t.activeTool = null;
          setStatusLabel(msg.requestId, t._wasStreamed ? 'Responding…' : 'Thinking…', { done: true });
        }
        // A NEW card closes the current text segment so following text appears after it.
        // (Updates to an existing card — same toolCallId — must NOT, or streaming text
        // mid-tool would fragment.) build/upsert handles the DOM; we only flip the flag.
        const isNew = !t.flow.querySelector(`[data-tc="${msg.toolCallId}"]`);
        upsertTool(t, msg);
        if (isNew) t.currentText = null;
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
          send({ type: 'commandApprovalResponse', id: msg.id, approved, sessionId: msg.sessionId });
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
          send({ type: 'editApprovalResponse', id: msg.id, approved, sessionId: msg.sessionId });
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
        const head = document.createElement('div'); head.className = 'plan-head';
        head.innerHTML = `<span class="plan-head-icon">◈</span><span>Plan</span>`;
        t.body.appendChild(head);
        // A replayed or already-decided card (session switch, kept after Discard/Keep-discussing) —
        // show a read-only checklist, no edit controls, no action row.
        const settled = !!(msg.discarded || msg.deferred);
        const listEl = renderPlanChecklist(parsePlanSteps(msg.steps), !settled);
        t.body.appendChild(listEl);
        if (settled) { scrollDown(); break; }
        const collect = () => collectPlanSteps(listEl);
        const actions = document.createElement('div'); actions.className = 'plan-actions';
        const approve = document.createElement('button'); approve.className = 'primary plan-run'; approve.textContent = '▶  Run plan';
        const discuss = document.createElement('button'); discuss.className = 'plan-discuss'; discuss.textContent = 'Discuss';
        const reject = document.createElement('button'); reject.className = 'plan-reject'; reject.textContent = 'Discard';
        approve.addEventListener('click', () => { actions.remove(); send({ type: 'approvePlan', requestId: newId(), approved: true, steps: collect() }); });
        reject.addEventListener('click', () => { actions.remove(); send({ type: 'approvePlan', requestId: newId(), approved: false, steps: collect() }); });
        discuss.addEventListener('click', () => {
          discuss.remove(); reject.remove();
          const note = document.createElement('div'); note.className = 'plan-note';
          note.textContent = 'Kept for discussion — edit steps above or the saved plan, then Run when ready.';
          t.body.appendChild(note);
          send({ type: 'deferPlan', requestId: msg.requestId, steps: collect() });
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
          send({ type: 'askUserResponse', requestId: msg.requestId, callId: msg.callId, answer });
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
        // Collapse the question form into a compact recap so it's obvious the input was
        // accepted — otherwise the disabled form sits there looking stale/unsubmitted.
        function markClarifyDone(title, answers) {
          card.classList.add('done');
          card.innerHTML = '';
          const h = document.createElement('div'); h.className = 'clarify-intro'; h.textContent = title;
          card.appendChild(h);
          if (answers) {
            const recap = document.createElement('div'); recap.className = 'clarify-recap';
            qs.forEach((q, qi) => {
              const row = document.createElement('div'); row.className = 'clarify-recap-row';
              const ql = document.createElement('span'); ql.className = 'clarify-recap-q'; ql.textContent = (q.label || `Q${qi + 1}`) + ':';
              const al = document.createElement('span'); al.className = 'clarify-recap-a'; al.textContent = answers[qi];
              row.appendChild(ql); row.appendChild(al);
              recap.appendChild(row);
            });
            card.appendChild(recap);
          }
          scrollDown();
        }
        back.addEventListener('click', () => { if (cur > 0) { cur--; renderStep(); } });
        next.addEventListener('click', () => {
          if (!isLast()) { if (answered(cur)) { cur++; renderStep(); } return; }
          if (!allAnswered()) return;
          const answers = qs.map((q, qi) => selected[qi] === CUSTOM(qi) ? custom[qi].trim() : q.options[selected[qi]].title);
          markClarifyDone('✓ Answers submitted — resuming…', answers);
          send({ type: 'answerClarifying', requestId: msg.requestId, answers });
        });
        dismiss.addEventListener('click', () => {
          // Let the planner proceed on its own best judgment for every question.
          const answers = qs.map(() => '(no preference — use your best judgment)');
          markClarifyDone('✗ Dismissed — proceeding with sensible defaults.', null);
          send({ type: 'answerClarifying', requestId: msg.requestId, answers });
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
        t._wasStreamed = true;
        // The model is now synthesizing the answer. Cheap, idempotent write; the guard inside
        // setStatusLabel keeps a running tool's verb from being clobbered mid-tool.
        setStatusLabel(msg.requestId, 'Responding…');
        // Append into the CURRENT text segment of the flow. A tool/reasoning card between
        // text closes the segment (sets currentText=null), so the next token opens a new
        // segment AFTER that card — yielding text → tool → text interleaving in order.
        if (!t.currentText) {
          t.currentText = document.createElement('div');
          t.currentText.className = 'flow-text bubble streaming';
          t.currentText._buf = '';
          t.flow.appendChild(t.currentText);
        }
        const seg = t.currentText;
        seg._buf += msg.text;
        if (!seg._pending) {
          seg._pending = true;
          requestAnimationFrame(() => {
            seg._pending = false;
            seg.innerHTML = '';
            seg.appendChild(renderMarkdown(stripClarifyBlock(seg._buf)));
            scrollDown();
          });
        }
        break;
      }
      case 'assistantMessage': {
        const t = ensureTarget(msg.requestId);
        stopStatusTimer(msg.requestId, true);
        // Remove streaming cursor from all text segments
        t.flow.querySelectorAll('.streaming').forEach((el) => el.classList.remove('streaming'));
        // Flush any pending streamed text segment immediately (a queued rAF may not have run).
        if (t.currentText && t.currentText._buf != null) {
          t.currentText.innerHTML = '';
          t.currentText.appendChild(renderMarkdown(stripClarifyBlock(t.currentText._buf)));
        }
        // Fold-up 💭 Reasoning disclosure only when no live 🧠 Thinking block already
        // captured it inline — otherwise the same reasoning would show twice. Placed at the
        // top of the flow (it preceded the work).
        if (msg.reasoning && !t.flow.querySelector('.think-block')) {
          const det = document.createElement('details'); det.className = 'reasoning';
          det.innerHTML = `<summary>Reasoning</summary>`;
          det.appendChild(renderMarkdown(msg.reasoning));
          t.flow.insertBefore(det, t.flow.firstChild);
        }
        t.el._copyText = msg.text;
        // Streamed turns already show their text interleaved in the flow — don't re-render
        // (that would duplicate). Only render here when nothing streamed (buffered tool turns
        // / non-streaming providers): append the full answer as a final flow segment.
        if (!t._wasStreamed) {
          const seg = document.createElement('div'); seg.className = 'flow-text bubble';
          seg.appendChild(renderMarkdown(stripClarifyBlock(msg.text)));
          t.flow.appendChild(seg);
        }
        t._wasStreamed = false;
        finalizeWork(msg.requestId);
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
          btn.addEventListener('click', () => { resume.remove(); send({ type: 'resume', requestId: newId() }); });
          resume.appendChild(btn);
          t.el.appendChild(resume);
        }
        scrollDown();
        break;
      }
      case 'usageTotals':
        updateFooter(msg.totals);
        renderUsageStatsCard(msg.totals && msg.totals.lifetime, msg.totals && msg.totals.retrieval);
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
        // Append into the flow (same layer as response text) so it appears directly
        // after the work summary — not nested inside the outer t.body bubble.
        const dest = t ? t.flow ?? t.body : (currentTurn || thread);
        // Replace any prior error notice for this turn so a failed retry (e.g. an
        // escalated takeover that also errors) can't stack two identical red marks.
        dest.querySelectorAll('.error-notice').forEach((e) => e.remove());
        const el = document.createElement('div'); el.className = 'error-notice';
        el.textContent = '⚠ ' + msg.message;
        dest.appendChild(el);
        scrollDown();
        break;
      }
      case 'busy': {
        busy = msg.busy;
        const sb = $('#btn-send');
        sb.innerHTML = busy ? ICON.stop : ICON.send;
        sb.title = busy ? 'Stop' : 'Send (Enter)';
        sb.classList.toggle('stopping', busy);
        updateSendEnabled();
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
      row.addEventListener('click', () => send({ type: 'diffCheckpointFile', id: msg.id, uri: f.uri }));
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
    const rows = listEl.querySelectorAll('.plan-row');
    const ic = document.createElement('span'); ic.className = 'plan-ic';
    ic.textContent = (rows.length + 1) + '.';
    const tx = document.createElement('span'); tx.className = 'plan-tx'; tx.contentEditable = 'plaintext-only'; tx.textContent = text || '';
    tx.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addPlanRow(listEl, '', true); }
      else if (e.key === 'Backspace' && !tx.textContent && listEl.querySelectorAll('.plan-row').length > 1) {
        e.preventDefault();
        const prev = row.previousElementSibling; row.remove();
        renumberPlanRows(listEl);
        const p = prev && prev.querySelector ? prev.querySelector('.plan-tx') : null; if (p) p.focus();
      }
    });
    const del = document.createElement('span'); del.className = 'plan-del'; del.title = 'Remove';
    del.innerHTML = '&times;';
    del.addEventListener('click', () => { if (listEl.querySelectorAll('.plan-row').length > 1) { row.remove(); renumberPlanRows(listEl); } });
    row.appendChild(ic); row.appendChild(tx); row.appendChild(del);
    const addBtn = listEl.querySelector('.plan-add');
    if (addBtn) listEl.insertBefore(row, addBtn); else listEl.appendChild(row);
    if (focus) tx.focus();
    return row;
  }
  function renumberPlanRows(listEl) {
    listEl.querySelectorAll('.plan-row .plan-ic').forEach((ic, i) => { ic.textContent = (i + 1) + '.'; });
  }

  function renderPlanChecklist(items, editable) {
    const listEl = document.createElement('div'); listEl.className = 'plan-list';
    if (editable) {
      const add = document.createElement('div'); add.className = 'plan-add'; add.textContent = '+ Add step';
      add.addEventListener('click', () => addPlanRow(listEl, '', true));
      listEl.appendChild(add);
      (items.length ? items : ['']).forEach((it) => addPlanRow(listEl, it, false));
    } else {
      items.forEach((it, i) => {
        const row = document.createElement('div'); row.className = 'plan-row';
        const ic = document.createElement('span'); ic.className = 'plan-ic'; ic.textContent = (i + 1) + '.';
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
    undo.addEventListener('click', () => send({ type: 'restoreCheckpoint', id: msg.id }));
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
      chip.addEventListener('click', () => send({ type: 'diffCheckpointFile', id: msg.id, uri: f.uri }));
      list.appendChild(chip);
    });
    bar.appendChild(head); bar.appendChild(list);
    bar.classList.remove('hidden');
  }

  function updateFooter(totals) {
    if (!totals) return;
    const parts = [];
    const lt = totals.lifetime;
    const hasUsage = lt && (lt.totalTokens > 0 || lt.totalRequests > 0 || lt.estimatedSavingsUsd > 0);
    if (hasUsage) {
      parts.push(`<strong>Lifetime:</strong> ${fmtCompact(lt.totalTokens)} tokens`);
      parts.push(`<strong>Requests:</strong> ${fmtCompact(lt.totalRequests)}`);
      parts.push(`<strong>Saved:</strong> ${fmtUsd(lt.estimatedSavingsUsd)}`);
    } else {
      parts.push('<strong>No usage yet</strong>');
    }
    if (totals.context && totals.context.window) {
      const t = totals.context.tokens, w = totals.context.window;
      const pct = Math.min(100, Math.round((t / w) * 100));
      parts.push(`<strong>Ctx:</strong> ${fmtCompact(t)} / ${fmtCompact(w)} (${pct}%)`);
    }
    $('#footer').innerHTML = parts.join(' &middot; ');
  }

  // Render the "Usage data" card inside the Others tab. Safe to call before
  // the user opens the tab — looks up the element by id and bails if missing.
  let lastLifetime = { totalTokens: 0, totalRequests: 0, estimatedSavingsUsd: 0 };
  let lastRetrieval = null;
  function renderUsageStatsCard(lifetime, retrieval) {
    if (lifetime) lastLifetime = lifetime;
    if (retrieval !== undefined) lastRetrieval = retrieval;
    const el = document.getElementById('usage-stats-card');
    if (!el) return;
    const lt = lastLifetime;
    el.innerHTML = '';

    // Headline totals as three tiles instead of a plain list — the numbers
    // people actually scan for (tokens, requests, $ saved) get visual weight.
    const tiles = document.createElement('div');
    tiles.className = 'usage-tiles';
    const tile = (icon, value, label) => {
      const t = document.createElement('div'); t.className = 'usage-tile';
      const i = document.createElement('div'); i.className = 'usage-tile-icon'; i.textContent = icon;
      const v = document.createElement('div'); v.className = 'usage-tile-value'; v.textContent = value;
      const l = document.createElement('div'); l.className = 'usage-tile-label'; l.textContent = label;
      t.append(i, v, l);
      tiles.appendChild(t);
    };
    tile('◆', fmtTokens(lt.totalTokens || 0), 'Total tokens');
    tile('↻', String(lt.totalRequests || 0), 'Total requests');
    tile('$', fmtUsd(lt.estimatedSavingsUsd || 0), 'Est. saved');
    el.appendChild(tiles);

    if (lt.firstRecordedAt) {
      const since = document.createElement('div'); since.className = 'usage-since';
      since.textContent = `Tracking since ${new Date(lt.firstRecordedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
      el.appendChild(since);
    }

    const row = (label, value, badge) => {
      const r = document.createElement('div'); r.className = 'usage-stat-row';
      const l = document.createElement('span'); l.className = 'usage-stat-label'; l.textContent = label;
      const v = document.createElement('span'); v.className = 'usage-stat-value'; v.textContent = value;
      r.append(l, v);
      if (badge) {
        const b = document.createElement('span');
        b.className = 'usage-stat-badge ' + badge.cls;
        b.textContent = badge.text;
        r.appendChild(b);
      }
      el.appendChild(r);
    };

    // Retrieval quality section — only shown after ≥3 agent requests
    if (lastRetrieval && lastRetrieval.totalRequests >= 3) {
      const sep = document.createElement('div'); sep.className = 'usage-stat-sep'; el.appendChild(sep);
      const hdr = document.createElement('div'); hdr.className = 'usage-stat-hdr'; hdr.textContent = 'Retrieval quality'; el.appendChild(hdr);
      const hitRate = (lastRetrieval.symbolHitRate || 0) + (lastRetrieval.cacheHitRate || 0);
      const kpi = hitRate >= 80 ? { cls: 'badge-green', text: 'GOOD' } : hitRate >= 60 ? { cls: 'badge-yellow', text: 'OK' } : { cls: 'badge-red', text: 'POOR' };
      row('Cache hit rate', hitRate + '%', kpi);
      row('  Symbol index', (lastRetrieval.symbolHitRate || 0) + '%');
      row('  Bundle cache', (lastRetrieval.cacheHitRate || 0) + '%');
      const grepKpi = (lastRetrieval.grepRate || 0) <= 20 ? { cls: 'badge-green', text: '✓' } : { cls: 'badge-red', text: '✗ high' };
      row('Grep fallback', (lastRetrieval.grepRate || 0) + '%', grepKpi);
      row('Requests sampled', String(lastRetrieval.totalRequests));
    }

    // Reset the clear button label if it was in "Clearing…" state.
    const btn = document.getElementById('usage-clear-btn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Clear usage data';
    }
  }

  renderEmpty();
  send({ type: 'ready' });
})();
