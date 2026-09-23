/* MCP on an OpenAI-shaped wire (2026-09-07): a tool name over the 64-char function-name limit
 * is rejected with a 400 that kills the WHOLE request, so the names TierMux hands Cline's
 * createMcpTools are capped with a stable hash. Connections and calls are Cline's.
 * Run: npm run test:e2e:mcp-wire */
import { mcpToolName } from '../src/mcp/mcpManager';

let bad = 0;
const ok = (n: string, c: boolean, d = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? `   (${d})` : ''}`); if (!c) bad++; };
const VALID = /^[a-zA-Z0-9_-]+$/;

async function main() {
  console.log('— tool names always fit the wire —');
  {
    const short = mcpToolName('github', 'create_issue');
    ok('1. a short name is left readable', short === 'mcp__github__create_issue', short);

    const long = mcpToolName('atlassian-confluence-cloud', 'get_page_content_by_id_with_body_format');
    ok('2. an over-long name is capped at 64', long.length === 64, `${long.length}: ${long}`);
    ok('3. …and stays a legal function name', VALID.test(long), long);
    ok('4. …keeps a readable prefix', long.startsWith('mcp__atlassian-confluence-cloud__'), long);
    ok('5. …and is stable across reconnects',
      long === mcpToolName('atlassian-confluence-cloud', 'get_page_content_by_id_with_body_format'));

    const a = mcpToolName('server-one', 'x'.repeat(80));
    const b = mcpToolName('server-one', 'y'.repeat(80));
    ok('6. two different long tools do not collide', a !== b, `${a} / ${b}`);

    const weird = mcpToolName('my server.v2', 'do:the/thing');
    ok('7. illegal characters are replaced, not dropped', VALID.test(weird) && weird.includes('my_server_v2'), weird);

    const huge = mcpToolName('x'.repeat(200), 'y'.repeat(200));
    ok('8. a pathological pair still fits and is legal', huge.length === 64 && VALID.test(huge), `${huge.length}`);
  }

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
