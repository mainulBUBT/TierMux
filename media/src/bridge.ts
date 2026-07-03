// Webview messaging bridge — the single typed entry point between the browser
// webview and the extension host. Messaging-only: do not add DOM, rendering,
// state, or unrelated helpers here (its public exports are a stable API).
//
// Phase C scope: this module is strict-checked and shares the REAL contract
// (InMessage/OutMessage) from the host. The definition of `send()` is validated
// here; its CALL SITES in main.ts are not (main.ts is still @ts-nocheck until
// Phase D). The receive dispatcher + an `assertNever` exhaustiveness helper are
// intentionally deferred to Phase D — added only when a checked receive switch
// exists, so this file carries no dead code.
import type { InMessage, OutMessage } from '../../src/shared/webview-types';

// acquireVsCodeApi() may be called AT MOST ONCE per webview instance (a second
// call throws). It lives here so the singleton is owned in one place; main.ts
// imports the handle.
const vscode = acquireVsCodeApi();
export { vscode };

/** What the webview RECEIVES from the host. */
export type HostMessage = OutMessage;
/** What the webview SENDS to the host. */
export type ClientMessage = InMessage;

/**
 * Webview→self synthetic events (the host never sends these). Union form so
 * future local UI events (refresh / reset / reloadPreview / …) drop in
 * consistently with the message-union style.
 */
export type InternalMessage =
  | { type: 'clear' };

/** Everything the receive handler must be able to accept. */
export type RxMessage = HostMessage | InternalMessage;

/**
 * Send a message to the host. The payload shape is checked against `InMessage`
 * HERE; note that call sites in `main.ts` are unchecked until Phase D removes
 * `@ts-nocheck`.
 */
export function send(msg: ClientMessage): void {
  vscode.postMessage(msg);
}
