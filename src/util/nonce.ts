import { randomBytes } from 'crypto';

/** A 32-char random nonce for the webview CSP. */
export function getNonce(): string {
  return randomBytes(16).toString('hex');
}
