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

// Friendly per-message usage, e.g. "4.3k in · 67 out".
export function fmtUsage(u?: { promptTokens?: number; completionTokens?: number } | null): string {
  if (!u) return '';
  return `${fmtTokens(u.promptTokens ?? 0)} in · ${fmtTokens(u.completionTokens ?? 0)} out`;
}

// Dollar formatter for the "est. $ saved" line. Two decimals by default;
// sub-cent amounts show as "$0.00" so the line never reads like a precise bill.
export function fmtUsd(n: number): string {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '$0.00';
  return '$' + n.toFixed(2);
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
