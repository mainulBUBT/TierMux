// Webview messaging bridge — the single typed entry point to the extension host. Messaging only;
// public exports are a stable API. `send()` is checked against the real InMessage contract here;
// its call sites in main.ts are not until @ts-nocheck goes.
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

/** Webview→self synthetic events (the host never sends these). */
export type InternalMessage =
  | { type: 'clear' };

/** Everything the receive handler must be able to accept. */
export type RxMessage = HostMessage | InternalMessage;

/** Send a message to the host. */
export function send(msg: ClientMessage): void {
  vscode.postMessage(msg);
}
