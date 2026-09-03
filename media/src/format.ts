// Pure formatting helpers: number/date in -> string out.
// Stateless, side-effect free — safe to import from anywhere in the webview.

export function fmtTime(ts?: number | string | Date): string {
  const d = ts ? new Date(ts) : new Date();
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${m < 10 ? '0' + m : m} ${ap}`;
}

// Compact token count: 4325 -> "4.3k", 67 -> "67", 1200000 -> "1.2M".
export function fmtTokens(n: number): string {
  n = Math.max(0, Math.round(n || 0));
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// Compact K/M/B formatter (capitalized suffix) for the footer summary.
export function fmtCompact(n: number): string {
  n = Math.max(0, Math.round(n || 0));
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Friendly per-message usage, e.g. "4.3k in · 67 out · 12 reason".
export function fmtUsage(u?: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } | null): string {
  if (!u) return '';
  const parts = [`${fmtTokens(u.promptTokens ?? 0)} in`, `${fmtTokens(u.completionTokens ?? 0)} out`];
  if (u.reasoningTokens) parts.push(`${fmtTokens(u.reasoningTokens)} reason`);
  return parts.join(' · ');
}

// Dollar formatter for the "est. $ saved" line. Two decimals by default;
// sub-cent amounts show as "$0.00" so the line never reads like a precise bill.
export function fmtUsd(n: number): string {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '$0.00';
  return '$' + n.toFixed(2);
}

// Human duration: 42 -> "42s", 182 -> "3m 2s", 3755 -> "1hr 2m", 90000 -> "25hr".
// Seconds stay bare only under a minute; above that the largest two significant units
// carry the display (a live timer never needs "1hr 2m 3s" precision).
export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}hr ${m % 60}m` : `${h}hr`;
}

// Per-tool-call duration: most calls (reads, greps) settle in well under a second, where
// fmtDuration's whole-second rounding would show "0s" for nearly everything — the one signal
// item 3 (docs/UI_POLISH_TOOL_REASONING_2026-09-02.md) is trying to add. One decimal below a
// second, keeping a real (never-zero) floor so a genuinely instant call still reads as timed
// rather than blank; a second or more falls back to fmtDuration's normal m/h scaling.
export function fmtToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0.1, Math.round(ms / 100) / 10).toFixed(1)}s`;
  return fmtDuration(ms / 1000);
}

export function fmtSessionDate(ts?: number | string | Date | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const date = isToday ? 'Today' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${date} ${h12}:${pad(m)} ${ampm}`;
}
