// TYPE-ONLY GATEWAY — `export type` only.
//
// This file is the ONLY path the browser webview has to the host's message
// contract. It MUST stay type-only: never add runtime code here (no
// `const`, `enum`, `function`, or `class`). A runtime value would ship real
// code into the browser bundle and silently break the import boundary
// (media/src → src/shared is type-only by rule; see plans/abundant-tinkering-key.md).
//
// `src/messages.ts` is pure types today. If runtime exports are ever needed
// there, they must live in a SEPARATE runtime module — never forwarded through
// this gateway to the webview.
//
// Keep this list to types that genuinely exist in ../messages (re-exporting a
// non-existent name is a compile error). ClarifyingQuestion / TodoItem /
// McpServerConfig are imported by messages.ts from elsewhere; reach them via
// their own modules, not here, to avoid a second source of truth.
export type {
  InMessage,
  OutMessage,
  ConfigPayload,
  TranscriptMessage,
  TranscriptStep,
  SessionStatus,
  UsageTotals,
  UsagePayload,
  Attachment,
  AttachmentKind,
  MentionItem,
  McpRegistryItem,
  McpServerInfo,
  CheckpointFile,
  KeyStatusInfo,
} from '../messages';
