

import type * as vscode from 'vscode';
import type { AnnouncementItem } from '../messages';
import { fetchText, joinBase } from './catalog';

/** Announcement ids the user has opened the Tips page for (drives the unseen dot). */
export const SEEN_ANNOUNCEMENTS_KEY = 'tiermux.seenAnnouncements';
/** Announcement ids a toast has already been shown for (first-run seed keeps installs quiet). */
export const NOTIFIED_ANNOUNCEMENTS_KEY = 'tiermux.notifiedAnnouncements';

/**
 * Fetch the worker's `/announcements` endpoint: `{ announcements: [{ id, title, details }],
 * last_updated }`. The worker serves rows oldest-first (`ORDER BY id`), so items are re-sorted
 * NEWEST-first here — every consumer (webview feed, toasts) wants the latest announcement at
 * the top. Returns null on any failure (offline, bad URL, non-JSON) so callers can no-op.
 */
export async function fetchAnnouncements(baseRaw: string | undefined): Promise<{ items: AnnouncementItem[]; lastUpdated?: string } | null> {
  const base = (baseRaw ?? '').trim();
  if (!base) return null;
  const text = await fetchText(joinBase(base, 'announcements'));
  if (text === null) return null;
  return parseAnnouncementsBody(text);
}

/** Parse an `/announcements` response body into newest-first items. Exported for tests. */
export function parseAnnouncementsBody(text: string): { items: AnnouncementItem[]; lastUpdated?: string } | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const obj = body as { announcements?: unknown; last_updated?: unknown };
  if (!Array.isArray(obj.announcements)) return null;
  const items: AnnouncementItem[] = [];
  for (const e of obj.announcements) {
    if (!e || typeof e !== 'object') continue;
    const o = e as { id?: unknown; title?: unknown; details?: unknown };
    const title = String(o.title ?? '').trim();
    const details = String(o.details ?? '').trim();
    if (!title && !details) continue;
    const id = typeof o.id === 'number' ? o.id : Number(o.id) || 0;
    items.push({ id, title, details });
  }
  items.sort((a, b) => b.id - a.id);
  const lastUpdated = typeof obj.last_updated === 'string' ? obj.last_updated : undefined;
  return { items, lastUpdated };
}

/**
 * Announcements not yet toasted, marking them notified as a side effect. A missing notified
 * key (first run of this feature) seeds silently with every current id so an install isn't
 * greeted with a toast for the whole backlog — same pattern as seedNotifiedModels.
 */
export function unnotifiedAnnouncements(mem: vscode.Memento, items: AnnouncementItem[]): AnnouncementItem[] {
  if (!items.length) return [];
  const stored = mem.get<number[]>(NOTIFIED_ANNOUNCEMENTS_KEY);
  if (stored === undefined) {
    void mem.update(NOTIFIED_ANNOUNCEMENTS_KEY, items.map((i) => i.id));
    return [];
  }
  const notified = new Set(stored);
  const fresh = items.filter((i) => !notified.has(i.id));
  if (fresh.length) void mem.update(NOTIFIED_ANNOUNCEMENTS_KEY, [...stored, ...fresh.map((i) => i.id)]);
  return fresh;
}

/** Ids the user hasn't read yet (their tip card was never expanded). A missing seen key
 *  counts as all-seen, mirroring the first-run seed above. */
export function unseenAnnouncementIds(mem: vscode.Memento, items: AnnouncementItem[]): number[] {
  const stored = mem.get<number[]>(SEEN_ANNOUNCEMENTS_KEY);
  if (stored === undefined) return [];
  const seen = new Set(stored);
  return items.filter((i) => !seen.has(i.id)).map((i) => i.id);
}

/** Mark every given item as seen. Callers pass either the single tip whose card was just
 *  expanded or the whole feed ("Mark all read") — opening the page alone marks nothing, so
 *  the dot keeps pointing at a tip until it has actually been read. */
export async function markAnnouncementsSeen(mem: vscode.Memento, items: AnnouncementItem[]): Promise<void> {
  const stored = mem.get<number[]>(SEEN_ANNOUNCEMENTS_KEY) ?? [];
  const seen = new Set(stored);
  let changed = false;
  for (const i of items) {
    if (!seen.has(i.id)) { seen.add(i.id); changed = true; }
  }
  if (changed) await mem.update(SEEN_ANNOUNCEMENTS_KEY, [...seen]);
}
