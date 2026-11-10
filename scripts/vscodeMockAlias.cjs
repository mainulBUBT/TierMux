/* esbuild --alias target so the bundled e2e file can run under bun, which does not
 *  honour node's `Module._load` hook that vscodeMock.cjs installs (bun resolves 'vscode'
 *  as a real package and fails). Used by test:e2e:opencode-lane:bun-live — see the header
 *  of scripts/opencodeLane.e2e.ts for why the live gate check needs bun. */
module.exports = require('./vscodeMock.cjs').vscodeMock;
