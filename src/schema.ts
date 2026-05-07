// Zod schemas for every JSON control message on the wire.
//
// Why zod: the control message handlers used to be a tower of `typeof
// m['type']` / `Number.isInteger(m['cols'])` checks. zod gives us:
//   1. one place where the contract lives
//   2. correct TypeScript types from `z.infer<>` so handler bodies are
//      type-checked against the same shape
//   3. discriminated-union parsing — bad / unknown / partial messages
//      get a structured error we can surface to the client cleanly
//
// On the wire format see PROTOCOL.md.

import { z } from 'zod';

// Session id mirrors the regex in src/protocol.ts. Kept as a separate
// schema so every message that takes one validates identically.
export const SessionId = z.string().regex(
  /^[a-zA-Z0-9_-]{1,64}$/,
  'session id must match /^[a-zA-Z0-9_-]{1,64}$/',
);

// Cols / rows clamp — same window the server's pty.resize will accept.
const Cols = z.number().int().min(2).max(1000);
const Rows = z.number().int().min(2).max(1000);

// === client -> server ====================================================
const Resize = z.object({
  type: z.literal('resize'),
  sessionId: SessionId,
  cols: Cols,
  rows: Rows,
});

const SessionList = z.object({ type: z.literal('session-list') });

const SessionOpen = z.object({
  type: z.literal('session-open'),
  id: SessionId,
});
const SessionClose = z.object({
  type: z.literal('session-close'),
  id: SessionId,
});
const SessionKill = z.object({
  type: z.literal('session-kill'),
  id: SessionId,
});
const SessionRename = z.object({
  type: z.literal('session-rename'),
  id: SessionId,
  newId: SessionId,
});
const SessionCwd = z.object({
  type: z.literal('session-cwd'),
  id: SessionId,
});

const TmuxMouse = z.object({
  type: z.literal('tmux-mouse'),
  on: z.boolean(),
});

// File upload start — the server will further validate `name` against
// upload.ts's basename rules and resolve the target dir.
const UploadStart = z.object({
  type: z.literal('upload-start'),
  sessionId: SessionId,
  name: z.string().min(1).max(255),
  size: z.number().int().min(0).max(500 * 1024 * 1024),
  mode: z.string().regex(/^0?[0-7]{3,4}$/).optional(),
});

// App-level ping. The WS protocol's own ping/pong frames also exist (server
// sends them every 30s for liveness), but mobile-PWA dead-connection cases
// sometimes need an app-level probe driven from the *client* side — e.g. on
// visibilitychange after iOS suspended the page. Server replies with `pong`
// echoing the client's `t` so the client can compute RTT if it wants.
const Ping = z.object({
  type: z.literal('ping'),
  t: z.number().optional(),
});

export const ClientControl = z.discriminatedUnion('type', [
  Resize,
  SessionList,
  SessionOpen,
  SessionClose,
  SessionKill,
  SessionRename,
  SessionCwd,
  TmuxMouse,
  UploadStart,
  Ping,
]);
export type ClientControl = z.infer<typeof ClientControl>;

// Validate, returning a typed result or an error string the server can
// fold into an `error` reply for the client.
export function parseControl(raw: unknown): { ok: true; msg: ClientControl } | { ok: false; reason: string } {
  const r = ClientControl.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  // Pick the first issue with a helpful path. zod's full tree is verbose
  // and we don't ship the message back to the client anyway; we just log
  // it and reply with a generic `unknown-type` / `bad-arg` shape.
  const first = r.error.issues[0];
  const path = first ? first.path.join('.') : '';
  const msg = first?.message ?? 'invalid';
  return { ok: false, reason: path ? `${path}: ${msg}` : msg };
}
