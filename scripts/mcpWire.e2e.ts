/* MCP on an OpenAI-shaped wire (2026-09-07): a tool name over the 64-char function-name limit
 * is rejected with a 400 that kills the WHOLE request, so names are capped with a stable hash;
 * a server's own instructions reach the prompt; both transports are time-bounded.
 * Run: npm run test:e2e:mcp-wire */
import { mcpToolName } from '../src/mcp/mcpManager';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../src/mcp/mcpClient';
import { composeSystemPrompt } from '../src/context/system';

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

  console.log('— a server\'s own instructions reach the model —');
  {
    const withMcp = composeSystemPrompt('agent', undefined, undefined, '## github\nAlways pass owner and repo explicitly.');
    ok('9. wrapped in its own block', withMcp.includes('<mcp_instructions>') && withMcp.includes('pass owner and repo'));
    ok('10. framed as advice, not authority', /where it does not conflict/i.test(withMcp));
    const without = composeSystemPrompt('agent', undefined, undefined, '   ');
    ok('11. no servers, no block', !without.includes('<mcp_instructions>'));
    const huge = composeSystemPrompt('agent', undefined, undefined, 'z'.repeat(9_000));
    ok('12. a verbose server cannot flood the prompt', huge.length < 8_000, `${huge.length}`);
  }

  console.log('— every MCP request is time-bounded —');
  ok('13. both transports share one bound', DEFAULT_REQUEST_TIMEOUT_MS === 30_000, String(DEFAULT_REQUEST_TIMEOUT_MS));

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
