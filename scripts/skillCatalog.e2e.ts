/* Skill catalog (2026-09-07). A skill runs with the agent's permissions, so who supplies the
 * list is a trust decision: the publisher's own worker and the file shipped in this extension
 * may mark an entry first-party; a catalog someone configures is merged in last and can neither
 * displace a known skill nor vouch for one. Run: npm run test:e2e:skill-catalog */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchSkillCatalog, searchSkills } from '../src/context/skillCatalog';
import { loadSkills, invalidateSkillsCache } from '../src/context/skills';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };

const REMOTE = {
  entries: [
    { id: 'mcp-thing', type: 'mcp', name: 'Not a skill', install: { args: ['x/y'] } },
    { id: 'sdk', type: 'skill', name: 'SDK Docs', tagline: 'Reference docs', repo: 'https://github.com/o/sdk-skill', tags: ['software'], verified: true, install: { args: ['o/sdk-skill'] } },
    { id: 'routes', type: 'skill', name: 'Routes', description: 'Long description used when tagline is absent', tags: ['web', 'a', 'b', 'c', 'd', 'e'], install: { args: ['o/skills', '--skill', 'routes'] } },
    { id: 'broken', type: 'skill', name: 'No install block' },
    { id: 'empty-args', type: 'skill', name: 'Empty args', install: { args: [] } },
    { id: 'sdk', type: 'skill', name: 'Duplicate id', install: { args: ['o/other'] } },
    { id: 'bundled-clash', type: 'skill', name: 'Impostor', install: { args: ['evil/repo'] }, verified: true },
  ],
};

/** An extension dir with our own shipped list, so the test does not depend on the real file. */
function makeExtension(): string {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-skreg-'));
  fs.mkdirSync(path.join(ext, 'media'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'media', 'skill-registry.json'), JSON.stringify({
    skills: [
      { id: 'bundled-clash', name: 'The real one', description: 'Ships with TierMux.', source: 'anthropics/skills', skill: 'bundled-clash', verified: true },
      { id: 'pdf', name: 'PDF', description: 'Read and write PDFs.', source: 'anthropics/skills', skill: 'pdf', verified: true },
    ],
  }));
  return ext;
}

function serveCatalog(body: unknown, status = 200): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}
function setUrl(url: string, catalogUrl = '', searchUrl = 'https://dir.test'): void {
  (globalThis as { __tiermuxTestConfig?: Record<string, unknown> }).__tiermuxTestConfig =
    { skillRegistryUrl: url, 'catalog.url': catalogUrl, skillRegistrySearchUrl: searchUrl };
}

async function main() {
  const ext = makeExtension();

  console.log('— nothing third-party is browsed by default —');
  setUrl('', '');
  serveCatalog({ entries: [{ id: 'x', type: 'skill', name: 'Should not appear', install: { args: ['a/b'] } }] });
  const bundledOnly = await fetchSkillCatalog(ext, true);
  ok('1. a blank URL shows only the shipped list', bundledOnly.length === 2 && !bundledOnly.some((i) => i.id === 'x'), bundledOnly.map((i) => i.id).join(','));
  ok('2. shipped entries are first-party', bundledOnly.every((i) => i.verified));
  ok('3. …with the source npx skills add takes', bundledOnly.every((i) => i.source === 'anthropics/skills' && !!i.skill));

  console.log('— a configured catalog is merged, but vouches for nobody —');
  setUrl('https://example.test/catalog.json', '');
  serveCatalog(REMOTE);
  const items = await fetchSkillCatalog(ext, true);

  ok('4. only skills are listed', !items.some((i) => i.id === 'mcp-thing'));
  ok('5. an entry with no install block is dropped', !items.some((i) => i.id === 'broken'));
  ok('6. …and one with empty args too', !items.some((i) => i.id === 'empty-args'));
  ok('7. a duplicate id is kept once', items.filter((i) => i.id === 'sdk').length === 1);

  const sdk = items.find((i) => i.id === 'sdk')!;
  ok('8. source is the owner/repo npx skills add takes', sdk.source === 'o/sdk-skill' && !sdk.skill, JSON.stringify(sdk));
  ok('9. tagline becomes the description', sdk.description === 'Reference docs');
  ok('10. a remote entry can NOT claim first-party, even saying verified:true', sdk.verified === false);

  const routes = items.find((i) => i.id === 'routes')!;
  ok('11. --skill is split out of the args', routes.source === 'o/skills' && routes.skill === 'routes');
  ok('12. description falls back when there is no tagline', routes.description.startsWith('Long description'));
  ok('13. tags are capped', routes.tags.length === 4, JSON.stringify(routes.tags));

  const clash = items.find((i) => i.id === 'bundled-clash')!;
  ok('14. a remote entry cannot shadow a shipped id', clash.source === 'anthropics/skills' && clash.name === 'The real one', JSON.stringify(clash));
  ok('15. first-party entries sort first', items[0].verified === true);
  ok('16. a third-party entry is still installable, just unvouched', !!routes.source && routes.verified === false);

  console.log('— the publisher\'s own worker serves the live list —');
  {
    let asked = '';
    globalThis.fetch = (async (u: unknown) => {
      asked = String(u);
      return new Response(JSON.stringify({ skills: [
        { id: 'pdf', name: 'PDF (updated)', description: 'Newer copy.', source: 'anthropics/skills', skill: 'pdf', firstParty: true },
        { id: 'brand-new', name: 'Added after release', description: 'Not in the shipped file.', source: 'anthropics/skills', skill: 'brand-new', firstParty: true },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    setUrl('', 'https://worker.test/');
    const live = await fetchSkillCatalog(ext, true);
    ok('17. the list comes from the catalog worker\'s /skills', asked === 'https://worker.test/skills', asked);
    ok('18. a skill added after release shows up', live.some((i) => i.id === 'brand-new'));
    ok('19. the live copy wins over the shipped one', live.find((i) => i.id === 'pdf')!.name === 'PDF (updated)');
    ok('20. shipped entries the live list omits are still there', live.some((i) => i.id === 'bundled-clash'));
    ok('21. the worker may mark first-party', live.find((i) => i.id === 'brand-new')!.verified === true);

    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const offline = await fetchSkillCatalog(ext, true);
    ok('22. a 404 from the worker leaves the shipped list intact', offline.length === 2 && offline.every((i) => i.verified), String(offline.length));
  }

  console.log('— failures never empty the panel —');
  setUrl('https://example.test/catalog.json', '');
  serveCatalog({}, 500);
  const afterError = await fetchSkillCatalog(ext, true);
  ok('23. an HTTP error still leaves the shipped list', afterError.length === 2 && afterError.every((i) => i.verified), String(afterError.length));
  fs.rmSync(ext, { recursive: true, force: true });

  console.log('— the directory answers "does a skill for X exist" —');
  {
    let asked = '';
    globalThis.fetch = (async (u: unknown) => {
      asked = String(u);
      return new Response(JSON.stringify({ skills: [
        { id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'pdf', source: 'anthropics/skills', installs: 191817 },
        { id: 'o/repo/thing', skillId: 'thing', name: 'thing', source: 'o/repo', installs: 12 },
        { id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'dupe', source: 'anthropics/skills' },
        { skillId: 'no-source', name: 'no source' },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    setUrl('', '', 'https://dir.test');
    const hits = await searchSkills('pdf');
    ok('24. the query reaches the directory', asked === 'https://dir.test/api/search?q=pdf', asked);
    ok('25. results map to an installable source/skill', hits[0].source === 'anthropics/skills' && hits[0].skill === 'pdf');
    ok('26. install counts stand in for the missing description', hits[0].description === '191,817 installs', hits[0].description);
    ok('27. a duplicate id is dropped', hits.filter((h) => h.id === 'anthropics/skills/pdf').length === 1);
    ok('28. an entry with no source is dropped', !hits.some((h) => h.name === 'no source'));
    ok('29. a directory result is NEVER first-party', hits.every((h) => !h.verified));
    ok('30. a one-character query never leaves the machine', (await searchSkills('a')).length === 0);
    setUrl('', '', '');
    ok('31. a blank search URL disables remote search', (await searchSkills('pdf')).length === 0);
  }

  console.log('— install / uninstall round trip —');
  {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-ext-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tiermux-ws-'));
    // A bundled skill (ships with the extension) and an installed package (in the workspace).
    fs.mkdirSync(path.join(extDir, '.tiermux', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(extDir, '.tiermux', 'skills', 'design.md'), '---\ndescription: Bundled.\n---\nBody.');
    const pkg = path.join(ws, '.agents', 'skills', 'routes');
    fs.mkdirSync(path.join(pkg, 'references'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'SKILL.md'), '---\ndescription: Installed.\n---\nBody.');
    fs.writeFileSync(path.join(pkg, 'references', 'a.md'), 'ref');

    const list = () => { invalidateSkillsCache(extDir, ws); return loadSkills(extDir, ws); };
    const first = list();
    ok('32. both are listed', first.has('design') && first.has('routes'), [...first.keys()].join(','));
    ok('33. a bundled skill offers no uninstall', first.get('design')!.removablePath === undefined);
    ok('34. an installed package points at its own FOLDER, not just SKILL.md',
      first.get('routes')!.removablePath === pkg, String(first.get('routes')!.removablePath));

    fs.rmSync(first.get('routes')!.removablePath!, { recursive: true, force: true });
    const after = list();
    ok('35. removing it takes the references with it', !fs.existsSync(pkg));
    ok('36. …and it stops being listed', !after.has('routes'));
    ok('37. the bundled one survives', after.has('design'));
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
