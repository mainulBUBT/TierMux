// Browsable skill list, same two-tier shape as the model catalog: the publisher's own worker
// serves the live list (so it can change without shipping an extension), and
// media/skill-registry.json is the offline fallback. A skill runs with the agent's permissions,
// so `firstParty` is only ever set by those two sources — a third-party catalog someone points
// `tiermux.skillRegistryUrl` at is merged in, but can never vouch for anything.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SkillCatalogItem } from '../messages';

const TTL_MS = 10 * 60_000;

interface RawEntry {
  id?: string; type?: string; name?: string; tagline?: string; description?: string;
  homepage?: string; repo?: string; tags?: unknown; verified?: unknown; firstParty?: unknown;
  source?: string; skill?: string;
  install?: { args?: unknown };
}

/** The live list: `tiermux.skillRegistryUrl` if set, else `<catalog.url>/skills` — the same
 *  worker that already serves /models and /providers, so the publisher can update the list
 *  without a release. Blank catalog url and blank override ⇒ bundled only. */
function liveListUrl(): { url: string; trusted: boolean } {
  const cfg = vscode.workspace.getConfiguration('tiermux');
  const override = cfg.get<string>('skillRegistryUrl', '').trim();
  if (override) return { url: override, trusted: false };
  const base = cfg.get<string>('catalog.url', '').trim().replace(/\/+$/, '');
  return base ? { url: `${base}/skills`, trusted: true } : { url: '', trusted: false };
}

/** `install.args` is `[source]` or `[source, '--skill', name]` — the shape catalogs use — or the
 *  bundled file's plain `source`/`skill` fields. */
function parseInstall(e: RawEntry): { source: string; skill?: string } | undefined {
  if (typeof e.source === 'string' && e.source.trim()) {
    return { source: e.source.trim(), ...(e.skill ? { skill: e.skill } : {}) };
  }
  const args = e.install?.args;
  if (!Array.isArray(args) || typeof args[0] !== 'string' || !args[0].trim()) return undefined;
  const flag = args.indexOf('--skill');
  const skill = flag >= 0 && typeof args[flag + 1] === 'string' ? String(args[flag + 1]) : undefined;
  return { source: String(args[0]).trim(), ...(skill ? { skill } : {}) };
}

function mapEntry(e: RawEntry, trusted: boolean): SkillCatalogItem | undefined {
  if (e.type && e.type !== 'skill') return undefined;
  const install = parseInstall(e);
  const id = (e.id ?? install?.skill ?? install?.source ?? '').trim();
  if (!install || !id) return undefined;
  return {
    id,
    name: (e.name ?? id).trim(),
    description: (e.tagline ?? e.description ?? '').trim().slice(0, 300),
    source: install.source,
    ...(install.skill ? { skill: install.skill } : {}),
    ...(e.homepage ?? e.repo ? { homepage: (e.homepage ?? e.repo) as string } : {}),
    tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string').slice(0, 4) : [],
    // `firstParty` asserts one checkable fact — the repo belongs to the vendor of the thing the
    // skill teaches — and only a trusted source may assert it.
    verified: trusted && (e.firstParty === true || e.verified === true),
  };
}

function collect(raw: RawEntry[], trusted: boolean, into: Map<string, SkillCatalogItem>): void {
  for (const e of raw) {
    const item = mapEntry(e, trusted);
    if (item && !into.has(item.id)) into.set(item.id, item);
  }
}

let cache: { at: number; items: SkillCatalogItem[] } | undefined;

/** One search result from the skills directory. It answers "does a skill for X exist" — which
 *  the curated list cannot — so results carry their real repo and install count and are never
 *  marked first-party. */
export async function searchSkills(query: string): Promise<SkillCatalogItem[]> {
  const base = vscode.workspace.getConfiguration('tiermux')
    .get<string>('skillRegistrySearchUrl', 'https://skills.sh').trim().replace(/\/+$/, '');
  if (!base || query.trim().length < 2) return [];
  const res = await fetch(`${base}/api/search?q=${encodeURIComponent(query.trim())}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`skills directory ${res.status}`);
  const data = (await res.json()) as { skills?: Array<{ id?: string; skillId?: string; name?: string; source?: string; installs?: number }> };
  const out: SkillCatalogItem[] = [];
  const seen = new Set<string>();
  for (const r of data.skills ?? []) {
    const source = (r.source ?? '').trim();
    const skill = (r.skillId ?? '').trim();
    const id = (r.id ?? `${source}/${skill}`).trim();
    if (!source || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: (r.name ?? skill ?? id).trim(),
      // The directory returns no description; the repo and install count are what it does know.
      description: typeof r.installs === 'number' ? `${r.installs.toLocaleString()} installs` : '',
      source,
      ...(skill ? { skill } : {}),
      homepage: `https://github.com/${source}`,
      tags: [],
      verified: false,
    });
  }
  return out;
}

/** Order decides who wins an id clash, and that is a trust decision:
 *  1. the publisher's own worker — trusted, and fresher than anything shipped;
 *  2. the file shipped in this extension — trusted, and the whole list when offline;
 *  3. a third-party catalog someone configured — merged in last, so it can neither displace a
 *     known entry nor claim first-party status. */
export async function fetchSkillCatalog(extensionPath: string, force = false): Promise<SkillCatalogItem[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.items;
  const items = new Map<string, SkillCatalogItem>();

  const { url, trusted } = liveListUrl();
  const fetchInto = async (): Promise<void> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return;
      const data = (await res.json()) as { entries?: RawEntry[]; skills?: RawEntry[] } | RawEntry[];
      collect(Array.isArray(data) ? data : data.entries ?? data.skills ?? [], trusted, items);
    } catch { /* offline, 404, or bad URL — the bundled list stands */ }
  };

  if (url && trusted) await fetchInto();
  try {
    const raw = await fs.promises.readFile(path.join(extensionPath, 'media', 'skill-registry.json'), 'utf8');
    collect((JSON.parse(raw) as { skills?: RawEntry[] }).skills ?? [], true, items);
  } catch { /* shipped file missing — whatever the live list carried still shows */ }
  if (url && !trusted) await fetchInto();

  const out = [...items.values()].sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || a.name.localeCompare(b.name));
  cache = { at: Date.now(), items: out };
  return out;
}
