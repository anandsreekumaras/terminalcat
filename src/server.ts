// Checkpoints 2–9 — multi-session WebSocket server with tagged binary frames.
//
// Wire spec: PROTOCOL.md (frame layout, control message shapes, lifecycle).
//
// Defense layers (intentionally redundant):
//   1. Loopback bind     (127.0.0.1, hard-checked at startup)
//   2. Access JWT verify (every HTTP request and WS upgrade)
//   3. Cf-Connecting-Ip  (presence-only heuristic — see auth.ts comment)
//
// One WS connection can be subscribed to many sessions concurrently; the
// server multiplexes outputs by sessionId. tmux is the source of truth for
// which sessions exist (`tmux list-sessions`), not our in-memory Map.
//
// What's intentionally NOT here yet:
//   - File upload handler  -> Checkpoint 11
//   - File download / webdl shim -> Checkpoint 12
//   - pino + daily rotation -> Checkpoint 13
//
// Run: pnpm dev

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type * as pty from 'node-pty';

import { config } from './config';
import { log } from './log';
import { parseControl } from './schema';
import { verifyAccessJwt, type AuthResult } from './auth';
import { randomBytes } from 'node:crypto';
import {
  TAG,
  encodeDataFrame,
  decodeDataFrame,
  encodeFilePayload,
  decodeFilePayload,
  isValidSessionId,
} from './protocol';
import {
  listSessions,
  killTmuxSession,
  renameTmuxSession,
  spawnPtyForSession,
  ensureTmuxMouseOn,
  setTmuxMouse,
  disableTmuxSplits,
  disableTmuxStatus,
  disableTmuxRightClickMenu,
  keepTmuxSelectionAfterDrag,
  enableTmuxClipboard,
  type SessionInfo,
} from './sessions';
import {
  startUpload,
  appendChunk,
  cleanupUpload,
  getSessionCwd,
  MAX_UPLOADS_PER_SESSION,
  MAX_UPLOADS_PER_WS,
  type Upload,
} from './upload';
import {
  startShimService,
  type DownloadRequest,
  type NotifyRequest,
  type ShimReply,
} from './download';

// === bind safety ===========================================================
// Architectural invariant: this server is only reachable via cloudflared,
// which terminates the tunnel locally on the same box. If HOST ever drifts
// off loopback, we'd expose an unauthenticated v1 (or a partial v2) server
// to the network. Hard-fail at startup rather than discover that in prod.
const HOST = '127.0.0.1';
const PORT = 7682;
if (HOST !== '127.0.0.1' && HOST !== '::1') {
  log.error(`refusing to start: HOST must be loopback, got ${HOST}`);
  process.exit(1);
}

// === env helper ============================================================
function definedEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const key of Object.keys(env)) {
    const v = env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
// `BROWSER` makes tools like gh, git, npm, etc. show URLs through our
// `terminalcat-open` shim instead of trying to launch a local browser
// on the headless VPS. Without this, `gh auth refresh` (and similar
// flows that want to open github.com) gets stuck waiting on an OAuth
// callback that can't reach a local listener — your real browser is on
// the device viewing this session, not on the VPS. The shim just prints
// the URL clearly so you can copy it into the browser you're actually
// using. See `bin/terminalcat-open` for what it does.
const TERMINALCAT_OPEN = path.resolve(__dirname, '..', 'bin', 'terminalcat-open');
const PTY_ENV = {
  ...definedEnv(process.env),
  BROWSER: TERMINALCAT_OPEN,
};
const PTY_CWD = process.env['HOME'] ?? '/tmp';

// === static file serving ===================================================
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

// Per-extension caching policy. Goal: keep `index.html` and `sw.js` always
// revalidating (so deploys land instantly) while letting browsers reuse
// the static assets that almost never change. ETag-based revalidation
// means even the "no-cache" path benefits from 304s — no body re-sent.
function cacheControlFor(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.html':
    case '.js':
      // Includes sw.js explicitly: must always revalidate so SW updates land.
      // `no-cache` doesn't mean "don't cache" — it means "use cache but
      // revalidate every time" (sends If-None-Match → 304 if unchanged).
      return 'no-cache, must-revalidate';
    case '.svg':
    case '.png':
    case '.ico':
    case '.woff2':
    case '.webmanifest':
      // Static assets that change rarely. 1 day cache + immutable hint
      // makes repeat visits skip the network entirely for these.
      return 'public, max-age=86400';
    default:
      return 'no-store';
  }
}

// Cheap ETag — same shape Express uses by default. Combines mtime and size,
// hex-formatted. Stable enough for revalidation (changes when file changes),
// not a content hash. If we ever care about distinguishing identical-mtime
// edits we'd swap for sha1, but for terminalcat's tiny file count this is fine.
function etagFor(stat: fs.Stats): string {
  return `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
}

// Send one file with ETag-aware response. Shared between the direct-match
// path and the SPA fallback so both get identical 304 / cache behaviour.
function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  stat: fs.Stats,
): void {
  const etag = etagFor(stat);
  const cc = cacheControlFor(file);
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': cc });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': mimeFor(file),
    'Content-Length': stat.size,
    'Cache-Control': cc,
    'ETag': etag,
  });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

function send404(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end('not found\n');
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    res.end();
    return;
  }
  const u = new URL(req.url ?? '/', 'http://placeholder');
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const candidate = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden\n');
    return;
  }

  fs.stat(candidate, (err, stat) => {
    if (!err && stat.isFile()) {
      sendFile(req, res, candidate, stat);
      return;
    }
    // SPA fallback: paths that look like routes (no extension) get
    // index.html so e.g. /tab/foo or a bookmarked deep link loads the
    // app and the frontend handles it (or just renders the default
    // state — terminalcat doesn't have client-side routing today).
    // Paths with extensions stay as a clean 404 so missing assets
    // surface in devtools instead of being masked by a 200 HTML body.
    if (path.extname(pathname)) {
      send404(res);
      return;
    }
    const indexPath = path.resolve(PUBLIC_DIR, 'index.html');
    fs.stat(indexPath, (err2, stat2) => {
      if (err2 || !stat2.isFile()) {
        // Pathological: index.html missing. Only happens if someone
        // deletes public/index.html out from under the running server.
        send404(res);
        return;
      }
      sendFile(req, res, indexPath, stat2);
    });
  });
}

// === auth gate ============================================================
function authenticateRequest(req: http.IncomingMessage): Promise<AuthResult> {
  if (!req.headers['cf-connecting-ip']) {
    return Promise.resolve({ ok: false, reason: 'missing Cf-Connecting-Ip' });
  }
  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string' || !token) {
    return Promise.resolve({ ok: false, reason: 'missing Cf-Access-Jwt-Assertion' });
  }
  return verifyAccessJwt(token);
}

function clientIp(req: http.IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  if (Array.isArray(cf) && cf[0]) return cf[0];
  return req.socket.remoteAddress ?? '?';
}

const server = http.createServer((req, res) => {
  authenticateRequest(req).then((result) => {
    if (!result.ok) {
      log.warn(
        `[auth] http 401 ip=${clientIp(req)} url=${req.url ?? '?'} reason="${result.reason}"`,
      );
      res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('unauthorized\n');
      return;
    }
    serveStatic(req, res);
  }).catch((err: unknown) => {
    log.error({ err }, '[auth] http verify threw');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error\n');
    } else {
      res.end();
    }
  });
});

// === multi-session state ==================================================
// The Map is OUR view of "sessions for which we have an attached PTY child".
// It is NOT the source of truth for "sessions that exist" — that's tmux.
// Entries appear when the first WS subscribes to a session, disappear when
// the last WS unsubscribes (PTY child reaped; tmux session persists).
//
// `id` is mutable: when a session is renamed via `session-rename`, we update
// it on the entry so subsequent STDOUT framing uses the new id. Subscribers
// already received `session-renamed` so they re-key their tabs.
interface ActivePty {
  id: string;
  pty: pty.IPty;
  /** Subscribers currently receiving STDOUT frames for this session. */
  subscribers: Set<WebSocket>;
  /**
   * Each subscriber's last-announced viewport size. The PTY is sized to
   * the smallest cols + rows across all of them, mirroring tmux's
   * multi-client behaviour. Without this, a small mobile client and a
   * large desktop client attached to the same session would oscillate
   * the PTY size every time either fired a resize control message —
   * tmux re-paints the whole screen on every resize, which the user
   * sees as flicker.
   */
  subscriberSizes: Map<WebSocket, { cols: number; rows: number }>;
}
const active = new Map<string, ActivePty>();

// Compute the effective (smallest-wins) PTY size across an entry's
// subscribers. Returns null if no subscriber has reported a size yet
// (e.g. brand-new attachment hasn't sent its first resize) — caller
// should leave the PTY unchanged.
function effectiveSizeFor(a: ActivePty): { cols: number; rows: number } | null {
  let cols = Infinity;
  let rows = Infinity;
  for (const sub of a.subscribers) {
    const s = a.subscriberSizes.get(sub);
    if (!s) continue;
    if (s.cols < cols) cols = s.cols;
    if (s.rows < rows) rows = s.rows;
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
  return { cols, rows };
}

// === stdout output batching (opt-in) ======================================
// Per-session pending buffer + flush timer. If OUTPUT_BATCH_MS > 0, stdout
// chunks are coalesced for that many ms before sending one combined frame.
// Off by default — the headline keystroke RTT is reported with batching off.
// Useful for screen-spam workloads (htop, animation) where it can cut
// per-frame WS overhead at the cost of `OUTPUT_BATCH_MS` of added latency.
// Capped at 100ms; anything bigger is almost certainly a misconfig.
const OUTPUT_BATCH_MS = (() => {
  const v = process.env['OUTPUT_BATCH_MS'];
  if (v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0;
})();

// Keyed by ActivePty (NOT entry.id) so renames don't desync the buffer.
const pendingOutput = new WeakMap<ActivePty, { buf: Buffer; timer: NodeJS.Timeout }>();

function flushPendingOutput(entry: ActivePty): void {
  const p = pendingOutput.get(entry);
  if (!p) return;
  pendingOutput.delete(entry);
  clearTimeout(p.timer);
  if (p.buf.length === 0) return;
  const frame = encodeDataFrame(TAG.STDOUT, entry.id, p.buf);
  broadcastToSubscribers(entry.id, frame);
}

function emitStdout(entry: ActivePty, buf: Buffer): void {
  if (OUTPUT_BATCH_MS <= 0) {
    const frame = encodeDataFrame(TAG.STDOUT, entry.id, buf);
    broadcastToSubscribers(entry.id, frame);
    return;
  }
  const existing = pendingOutput.get(entry);
  if (existing) {
    existing.buf = Buffer.concat([existing.buf, buf]);
  } else {
    const timer = setTimeout(() => flushPendingOutput(entry), OUTPUT_BATCH_MS);
    pendingOutput.set(entry, { buf, timer });
  }
}

// Per-WS accounting of which sessions it's subscribed to. Used on WS close
// to clean up cleanly even if the client didn't send session-close frames.
const wsSubs = new WeakMap<WebSocket, Set<string>>();
function getSubs(ws: WebSocket): Set<string> {
  let s = wsSubs.get(ws);
  if (!s) { s = new Set(); wsSubs.set(ws, s); }
  return s;
}

// Active uploads, keyed by uploadId. Per-WS and per-session counters are
// derived from this map for concurrency limits.
const uploads = new Map<string, Upload>();
const wsUploadIds = new WeakMap<WebSocket, Set<string>>();
const wsForUpload = new WeakMap<Upload, WebSocket>();

function getUploadIds(ws: WebSocket): Set<string> {
  let s = wsUploadIds.get(ws);
  if (!s) { s = new Set(); wsUploadIds.set(ws, s); }
  return s;
}
function countWsUploads(ws: WebSocket): number {
  return wsUploadIds.get(ws)?.size ?? 0;
}
function countSessionUploads(sessionId: string): number {
  let n = 0;
  for (const u of uploads.values()) if (u.sessionId === sessionId) n++;
  return n;
}
async function dropUpload(uploadId: string, reason: string): Promise<void> {
  const u = uploads.get(uploadId);
  if (!u) return;
  uploads.delete(uploadId);
  const ws = wsForUpload.get(u);
  if (ws) getUploadIds(ws).delete(uploadId);
  await cleanupUpload(u);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'upload-failed', uploadId, code: 'aborted', message: reason }));
  }
  log.warn(`[upload] ${uploadId} dropped: ${reason}`);
}

// Print a status line into a session's stdout (visible in the terminal,
// styled in dim cyan so it doesn't blend with shell output). Used for
// "[uploaded foo to /path]" etc. Goes through the same broadcast path
// as PTY data so all subscribers see it.
function injectStatus(sessionId: string, text: string): void {
  const styled = `\r\n\x1b[36m${text}\x1b[0m\r\n`;
  const frame = encodeDataFrame(TAG.STDOUT, sessionId, Buffer.from(styled, 'utf8'));
  broadcastToSubscribers(sessionId, frame);
}

// Backpressure guards. ws.bufferedAmount is the size in bytes of frames
// queued for send but not yet flushed to the kernel. Under healthy
// network + a responsive client it sits at ~0; under iOS PWA background
// suspension or a slow link it grows unboundedly because we have nothing
// to push back against. Two thresholds, both per-WS:
//
//   SOFT (4 MB) — start DROPPING this WS's PTY-output frames. tmux still
//                  has the canonical state, so on next reconnect the
//                  client's xterm gets repainted from there. Worst-case
//                  user-visible effect: a brief gap in scrollback during
//                  the slow period.
//   HARD (16 MB) — close the connection. Connection is effectively dead;
//                  forcing close lets the client's existing reconnect
//                  logic kick in (1 s backoff → fresh TCP), instead of
//                  sitting wedged forever waiting on a kernel-level
//                  flush that's never going to come.
const BACKPRESSURE_SOFT_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_HARD_BYTES = 16 * 1024 * 1024;
// Per-WS warn-rate limiting: log only the first drop in any 30 s window
// per connection so we don't fill journal with one line per dropped chunk.
const lastBackpressureWarnAt = new WeakMap<WebSocket, number>();

function broadcastToSubscribers(id: string, frame: Buffer): void {
  const a = active.get(id);
  if (!a) return;
  for (const ws of a.subscribers) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const buf = ws.bufferedAmount;
    if (buf >= BACKPRESSURE_HARD_BYTES) {
      // Connection is wedged. Force-close so the client's reconnect path
      // fires immediately instead of waiting on the keepalive 30-60 s.
      log.warn({ session: id, buffered: buf }, '[ws] hard backpressure, terminating');
      try { ws.terminate(); } catch { /* already gone */ }
      continue;
    }
    if (buf >= BACKPRESSURE_SOFT_BYTES) {
      const now = Date.now();
      const last = lastBackpressureWarnAt.get(ws) ?? 0;
      if (now - last > 30_000) {
        lastBackpressureWarnAt.set(ws, now);
        log.warn({ session: id, buffered: buf }, '[ws] soft backpressure, dropping output frame');
      }
      continue;
    }
    ws.send(frame);
    bumpDown(ws, frame.length);
  }
}

function broadcastCtrl(id: string, msg: Record<string, unknown>): void {
  const a = active.get(id);
  if (!a) return;
  const text = JSON.stringify(msg);
  const bytes = Buffer.byteLength(text, 'utf8');
  for (const ws of a.subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
      bumpDown(ws, bytes);
    }
  }
}

function broadcastClientCount(id: string): void {
  const a = active.get(id);
  if (!a) return;
  broadcastCtrl(id, { type: 'session-clients', id, count: a.subscribers.size });
}

function attachWsToSession(ws: WebSocket, id: string): void {
  let a = active.get(id);
  if (!a) {
    // First subscriber — spawn the PTY child and wire it up.
    const child = spawnPtyForSession(id, 80, 24, PTY_ENV, PTY_CWD);
    const entry: ActivePty = {
      id,
      pty: child,
      subscribers: new Set(),
      subscriberSizes: new Map(),
    };
    a = entry;
    active.set(id, a);
    log.info(`[pty] session=${id} spawned client pid=${child.pid}`);
    // First spawn typically starts the tmux server. Re-run mouse-on now
    // so we don't depend on whether the server already existed.
    void ensureTmuxMouseOn();

    child.onData((data) => {
      // node-pty's d.ts insists `data: string` regardless of `encoding: null`
      // we set on spawn — at runtime it hands us a Buffer. Cast and skip the
      // string→Buffer round-trip we used to do here.
      const buf = data as unknown as Buffer;
      // Use entry.id (mutable) so renames take effect. Don't capture
      // the original id by closure.
      emitStdout(entry, buf);
    });

    child.onExit(({ exitCode, signal }) => {
      // Flush any pending batched output before we tell subscribers the
      // session is closed — otherwise the last few bytes of a screen
      // redraw could vanish on a rapid-quit.
      flushPendingOutput(entry);
      log.info(`[pty] session=${entry.id} exit code=${exitCode} signal=${signal ?? '-'}`);
      broadcastCtrl(entry.id, { type: 'session-closed', id: entry.id, reason: 'pty-exit' });
      const aa = active.get(entry.id);
      if (aa) {
        for (const ws of aa.subscribers) {
          getSubs(ws).delete(entry.id);
        }
      }
      active.delete(entry.id);
    });
  }
  a.subscribers.add(ws);
  getSubs(ws).add(id);
  // Connection accounting — for the close-line summary.
  wsAccount.get(ws)?.sessionsOpened.add(id);
  broadcastClientCount(id);
}

function detachWsFromSession(ws: WebSocket, id: string, reason = 'detached'): void {
  const a = active.get(id);
  if (!a) {
    getSubs(ws).delete(id);
    return;
  }
  a.subscribers.delete(ws);
  a.subscriberSizes.delete(ws);
  getSubs(ws).delete(id);
  // Tell remaining subscribers (if any) the count just dropped.
  if (a.subscribers.size > 0) broadcastClientCount(id);
  // Re-compute the smallest-wins PTY size now that this subscriber's
  // dimensions are out of the picture. If a small mobile client just
  // detached and only a big desktop client remains, the PTY can grow
  // back to the desktop's size (one resize, no flicker).
  if (a.subscribers.size > 0) {
    const eff = effectiveSizeFor(a);
    if (eff && eff.cols >= 2 && eff.rows >= 2 && eff.cols <= 1000 && eff.rows <= 1000) {
      a.pty.resize(eff.cols, eff.rows);
    }
  }
  if (a.subscribers.size === 0) {
    // No more clients want this session: SIGHUP our PTY child (which is the
    // tmux *client*; the tmux *server* and the session itself live on).
    // Same shape as the C5 disconnect-cleanup path, just per-session.
    log.info(`[pty] session=${id} no subscribers -> SIGHUP`);
    try { a.pty.kill('SIGHUP'); } catch { /* already dead */ }
    setTimeout(() => {
      try { a.pty.kill('SIGKILL'); } catch { /* already dead */ }
    }, 250);
    active.delete(id);
  }
  // Tell this WS it's been detached.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'session-closed', id, reason }));
  }
}

// === control-message handlers =============================================
async function handleControl(ws: WebSocket, raw: unknown): Promise<void> {
  const parsed = parseControl(raw);
  if (!parsed.ok) {
    log.warn({ reason: parsed.reason }, '[ctrl] schema rejected');
    sendError(ws, 'malformed', parsed.reason);
    return;
  }
  const msg = parsed.msg;

  switch (msg.type) {
    case 'session-list': {
      try {
        const sessions = await listSessions();
        ws.send(JSON.stringify({ type: 'session-list', sessions }));
      } catch (err) {
        sendError(ws, 'tmux-failed', `list-sessions: ${(err as Error).message}`);
      }
      return;
    }

    case 'session-open': {
      attachWsToSession(ws, msg.id);
      ws.send(JSON.stringify({ type: 'session-opened', id: msg.id }));
      return;
    }

    case 'session-close': {
      detachWsFromSession(ws, msg.id, 'detached');
      return;
    }

    case 'session-kill': {
      try {
        await killTmuxSession(msg.id);
        ws.send(JSON.stringify({ type: 'session-killed', id: msg.id }));
      } catch (err) {
        sendError(ws, 'kill-failed', (err as Error).message);
      }
      return;
    }

    case 'session-rename': {
      const { id: oldId, newId } = msg;
      if (oldId === newId) {
        ws.send(JSON.stringify({ type: 'session-renamed', oldId, newId }));
        return;
      }
      if (active.has(newId)) {
        sendError(ws, 'rename-conflict', `session "${newId}" is already attached`);
        return;
      }
      try {
        await renameTmuxSession(oldId, newId);
      } catch (err) {
        sendError(ws, 'rename-failed', (err as Error).message);
        return;
      }
      const a = active.get(oldId);
      if (a) {
        a.id = newId;
        active.delete(oldId);
        active.set(newId, a);
        for (const sub of a.subscribers) {
          const subs = getSubs(sub);
          subs.delete(oldId);
          subs.add(newId);
        }
      }
      const notify = JSON.stringify({ type: 'session-renamed', oldId, newId });
      const notified = new Set<WebSocket>();
      if (a) {
        for (const sub of a.subscribers) {
          if (sub.readyState === WebSocket.OPEN) sub.send(notify);
          notified.add(sub);
        }
      }
      if (!notified.has(ws) && ws.readyState === WebSocket.OPEN) {
        ws.send(notify);
      }
      log.info({ oldId, newId }, '[ctrl] rename');
      return;
    }

    case 'resize': {
      const a = active.get(msg.sessionId);
      if (!a) return;
      // Defense: only attached subscribers may resize.
      if (!a.subscribers.has(ws)) {
        log.warn({ session: msg.sessionId }, '[ctrl] resize from non-subscriber, dropped');
        return;
      }
      // Record this subscriber's viewport size, then resize the PTY to
      // the smallest cols/rows across all current subscribers. With
      // multiple devices attached to one session, last-resize-wins
      // would oscillate the PTY between device dims and tmux would
      // re-paint on every change, causing visible flicker. Smallest-
      // wins gives a stable size: the small device sees content
      // correctly, the bigger device gets letterbox space.
      a.subscriberSizes.set(ws, { cols: msg.cols, rows: msg.rows });
      const eff = effectiveSizeFor(a);
      if (eff && eff.cols >= 2 && eff.rows >= 2 && eff.cols <= 1000 && eff.rows <= 1000) {
        a.pty.resize(eff.cols, eff.rows);
      }
      log.debug(
        { session: msg.sessionId, cols: msg.cols, rows: msg.rows, eff },
        '[ctrl] resize',
      );
      return;
    }

    case 'session-cwd': {
      const cwd = await getSessionCwd(msg.id);
      if (cwd) {
        ws.send(JSON.stringify({ type: 'session-cwd', id: msg.id, cwd }));
      }
      // No reply on failure — client polls again. Avoid spamming errors
      // for the common race where a session was just killed.
      return;
    }

    case 'tmux-mouse': {
      await setTmuxMouse(msg.on);
      ws.send(JSON.stringify({ type: 'tmux-mouse-state', on: msg.on }));
      return;
    }

    case 'ping': {
      // Echo `t` back so the client can compute round-trip if it wants;
      // the mere arrival of `pong` tells the client the connection is
      // alive end-to-end through CF + tunnel + origin.
      const reply: { type: 'pong'; t?: number } = { type: 'pong' };
      if (typeof msg.t === 'number') reply.t = msg.t;
      ws.send(JSON.stringify(reply));
      return;
    }

    case 'upload-start': {
      const args: Parameters<typeof startUpload>[0] = {
        sessionId: msg.sessionId,
        name: msg.name,
        size: msg.size,
      };
      if (msg.mode !== undefined) args.mode = msg.mode;
      const result = await startUpload(
        args,
        countWsUploads(ws),
        countSessionUploads(msg.sessionId),
      );
      if (!result.ok) {
        ws.send(JSON.stringify({
          type: 'upload-rejected',
          code: result.code,
          message: result.message,
        }));
        return;
      }
      uploads.set(result.upload.id, result.upload);
      getUploadIds(ws).add(result.upload.id);
      wsForUpload.set(result.upload, ws);
      ws.send(JSON.stringify({
        type: 'upload-ready',
        uploadId: result.upload.id,
        path: result.upload.finalPath,
      }));
      return;
    }
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'error', code, message }));
}

// === binary data handler ==================================================
function handleBinary(ws: WebSocket, raw: Buffer): void {
  const frame = decodeDataFrame(raw);
  if (!frame) {
    log.warn(`[data] malformed frame, ${raw.length} bytes, dropped`);
    return;
  }
  if (!isValidSessionId(frame.sessionId)) {
    log.warn(`[data] frame with invalid sessionId, dropped`);
    return;
  }

  switch (frame.tag) {
    case TAG.STDIN: {
      const a = active.get(frame.sessionId);
      if (!a) {
        // Stdin for an unattached session — could be a stale write from the
        // client during a close race. Drop quietly.
        return;
      }
      if (!a.subscribers.has(ws)) {
        log.warn(
          `[data] stdin from non-subscriber for session=${frame.sessionId}, dropped`,
        );
        return;
      }
      a.pty.write(frame.payload.toString('utf8'));
      return;
    }

    case TAG.FILE_UP_CHUNK: {
      const inner = decodeFilePayload(frame.payload);
      if (!inner) {
        log.warn(`[upload] malformed chunk payload, dropping`);
        return;
      }
      const upload = uploads.get(inner.id);
      if (!upload) {
        // Most likely race: client kept sending after we rejected/timed out.
        // Drop quietly to avoid log spam.
        return;
      }
      // Defense: only the WS that started the upload may feed it.
      if (wsForUpload.get(upload) !== ws) {
        log.warn(`[upload] chunk for ${inner.id} from foreign WS, dropping`);
        return;
      }
      void appendChunk(upload, inner.seq, inner.data).then((res) => {
        if ('error' in res) {
          void dropUpload(upload.id, res.error);
          return;
        }
        if (res.done) {
          uploads.delete(upload.id);
          getUploadIds(ws).delete(upload.id);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'upload-complete',
              uploadId: upload.id,
              path: res.path,
            }));
          }
          // Visible status line into the terminal — easy to ack the upload
          // from inside the shell (looks like `[uploaded foo to /path/]`).
          injectStatus(upload.sessionId, `[uploaded ${upload.name} to ${res.path}]`);
          log.info(`[upload] ${upload.id} complete -> ${res.path}`);
        } else {
          // Periodic progress every 16 chunks (~1 MiB at 64 KiB chunks).
          if (upload.expectedSeq % 16 === 0 && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'upload-progress',
              uploadId: upload.id,
              received: upload.bytesReceived,
            }));
          }
        }
      }).catch((err: unknown) => {
        void dropUpload(upload.id, (err as Error).message);
      });
      return;
    }

    default:
      log.warn(`[data] unknown tag 0x${frame.tag.toString(16)}, dropped`);
  }
}

// === download (server -> client, kicked off by the webdl shim) ============
const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024;
const DOWNLOAD_CHUNK_SIZE = 64 * 1024;

async function performDownload(req: DownloadRequest): Promise<ShimReply> {
  if (!isValidSessionId(req.sessionId)) {
    return { ok: false, error: 'invalid sessionId' };
  }
  if (typeof req.path !== 'string' || !req.path) {
    return { ok: false, error: 'path required' };
  }
  // Only downloadable: real files the server-user can read. We don't need
  // path sandboxing — the shim runs as the same user, so they can already
  // read anything they ask for. The CHECK is "is this a regular file we
  // can open and stream", not "is this in a safe dir".
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(req.path);
  } catch (err) {
    return { ok: false, error: `stat ${req.path}: ${(err as Error).message}` };
  }
  if (!stat.isFile()) return { ok: false, error: `not a regular file: ${req.path}` };
  if (stat.size > MAX_DOWNLOAD_SIZE) {
    return { ok: false, error: `file too large (${stat.size} > ${MAX_DOWNLOAD_SIZE})` };
  }

  // Pick subscribers. If the session has no attached client we can't
  // deliver the file — fail fast so the shim user sees an error.
  const a = active.get(req.sessionId);
  if (!a || a.subscribers.size === 0) {
    return { ok: false, error: `session "${req.sessionId}" has no attached client` };
  }

  const downloadId = 'd_' + randomBytes(6).toString('hex');
  const name = path.basename(req.path);
  const startMsg = JSON.stringify({
    type: 'download-start',
    downloadId,
    sessionId: req.sessionId,
    name,
    size: stat.size,
  });
  for (const ws of a.subscribers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(startMsg);
  }

  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(req.path, 'r');
  } catch (err) {
    const failMsg = JSON.stringify({
      type: 'download-failed', downloadId, code: 'open', message: (err as Error).message,
    });
    for (const ws of a.subscribers) if (ws.readyState === WebSocket.OPEN) ws.send(failMsg);
    return { ok: false, error: (err as Error).message };
  }

  let seq = 0;
  let sent = 0;
  const buf = Buffer.allocUnsafe(DOWNLOAD_CHUNK_SIZE);
  try {
    while (true) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      const filePayload = encodeFilePayload(downloadId, seq, chunk);
      const frame = encodeDataFrame(TAG.FILE_DOWN_CHUNK, req.sessionId, filePayload);
      // Backpressure-aware send: if any subscriber's buffer is high, yield.
      let needYield = false;
      for (const ws of a.subscribers) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(frame);
          if (ws.bufferedAmount > 4 * 1024 * 1024) needYield = true;
        }
      }
      seq++;
      sent += bytesRead;
      if (needYield) await new Promise((r) => setTimeout(r, 25));
      else if (seq % 32 === 0) await new Promise((r) => setImmediate(r));

      if (seq % 32 === 0) {
        const prog = JSON.stringify({ type: 'download-progress', downloadId, sent });
        for (const ws of a.subscribers) if (ws.readyState === WebSocket.OPEN) ws.send(prog);
      }
    }
    const done = JSON.stringify({ type: 'download-complete', downloadId });
    for (const ws of a.subscribers) if (ws.readyState === WebSocket.OPEN) ws.send(done);
    injectStatus(req.sessionId, `[downloading ${name} (${stat.size} bytes)]`);
    return { ok: true, result: { downloadId, sent } };
  } catch (err) {
    const failMsg = JSON.stringify({
      type: 'download-failed', downloadId, code: 'stream', message: (err as Error).message,
    });
    for (const ws of a.subscribers) if (ws.readyState === WebSocket.OPEN) ws.send(failMsg);
    return { ok: false, error: (err as Error).message };
  } finally {
    try { await fd.close(); } catch { /* */ }
  }
}

async function performNotify(req: NotifyRequest): Promise<ShimReply> {
  if (!isValidSessionId(req.sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof req.message !== 'string' || !req.message) return { ok: false, error: 'message required' };
  const a = active.get(req.sessionId);
  if (!a || a.subscribers.size === 0) {
    return { ok: false, error: `session "${req.sessionId}" has no attached client` };
  }
  const text = req.message.slice(0, 1024);     // bound the size
  const msg = JSON.stringify({ type: 'notify', sessionId: req.sessionId, message: text });
  for (const ws of a.subscribers) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  return { ok: true };
}

// === ws upgrade gate (auth) and connection handler ========================
// maxPayload caps any single inbound frame. Clients chunk large pastes to
// 64KB pieces (see pasteText() in public/index.html), so 4 MB is a generous
// ceiling that stops a misbehaving client from passing arbitrary-size frames.
// perMessageDeflate disabled deliberately: PTY output is mostly already-compact
// ANSI/UTF-8 — DEFLATE adds CPU + latency for ~zero compression gain on this
// kind of stream. Measured ~2× stdout throughput improvement when off.
// maxPayload caps any single inbound frame so pastes from the client can't blow
// past 4 MiB; clients chunk large pastes to stay under it.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4 * 1024 * 1024,
  perMessageDeflate: false,
});
const wsAuth = new WeakMap<WebSocket, { email: string; sub: string }>();

// === WS-protocol keepalive ================================================
// Standard ws-library idiom: server pings every PING_INTERVAL_MS. Browsers
// auto-respond with pong frames. If a client misses two consecutive pings,
// terminate — its TCP is gone (mobile NAT/CGNAT/CF tunnel idle, iOS PWA
// background suspend, etc.) but the WS object would otherwise sit "open"
// for minutes before the OS notices. This catches it within ~2*interval.
//
// Lives at protocol level so it doesn't even need a frontend code change
// to engage on existing clients. There's also an app-level ping handler
// above, used by the frontend's visibilitychange-driven probe for
// faster-than-30s detection on PWA wake.
const PING_INTERVAL_MS = 30_000;
const wsAlive = new WeakMap<WebSocket, boolean>();
const keepaliveTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (wsAlive.get(client) === false) {
      log.info(`[ws] keepalive: no pong, terminating dead connection`);
      try { client.terminate(); } catch { /* already gone */ }
      continue;
    }
    wsAlive.set(client, false);
    try { client.ping(); } catch { /* connection closing */ }
  }
}, PING_INTERVAL_MS);
keepaliveTimer.unref(); // don't block process exit on this timer

// Per-connection accounting. One log line is emitted at WS close with the
// totals — easier to grep than streaming every byte transfer to the log.
interface WsAccount {
  ip: string;
  email: string;
  openedAt: number;
  bytesUp: number;
  bytesDown: number;
  /** Set of every sessionId this WS subscribed to during its lifetime. */
  sessionsOpened: Set<string>;
}
const wsAccount = new WeakMap<WebSocket, WsAccount>();
function bumpUp(ws: WebSocket, n: number): void {
  const a = wsAccount.get(ws);
  if (a) a.bytesUp += n;
}
function bumpDown(ws: WebSocket, n: number): void {
  const a = wsAccount.get(ws);
  if (a) a.bytesDown += n;
}

server.on('upgrade', (req, socket, head) => {
  // CSWSH defense-in-depth. If ALLOWED_ORIGIN is configured AND the request
  // carries an Origin header, it must match. Permissive-missing semantics:
  // browsers always send Origin on WS upgrades from a document context —
  // that's the only attack vector for CSWSH. Non-browser tools (curl,
  // wscat, monitoring agents) typically omit Origin entirely; for those
  // the JWT check is the actual gate. This matches what most frameworks
  // do (e.g., Django Channels' AllowedHostsOriginValidator).
  // (We don't apply this to plain HTTP because terminalcat's HTTP path is
  // read-only static files; CSRF on a GET-only surface is theatre.)
  if (config.ALLOWED_ORIGIN) {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== config.ALLOWED_ORIGIN) {
      log.warn(
        `[auth] ws 403 ip=${clientIp(req)} origin=${JSON.stringify(origin)} reason="origin not allowed"`,
      );
      socket.write(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
      return;
    }
  }
  authenticateRequest(req).then((result) => {
    if (!result.ok) {
      log.warn(`[auth] ws 401 ip=${clientIp(req)} reason="${result.reason}"`);
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsAuth.set(ws, { email: result.email, sub: result.sub });
      wss.emit('connection', ws, req);
    });
  }).catch((err: unknown) => {
    log.error({ err }, '[auth] ws verify threw');
    socket.write(
      'HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
    socket.destroy();
  });
});

wss.on('connection', (ws, req) => {
  const auth = wsAuth.get(ws);
  const ip = clientIp(req);
  const email = auth?.email ?? '?';
  wsAccount.set(ws, {
    ip,
    email,
    openedAt: Date.now(),
    bytesUp: 0,
    bytesDown: 0,
    sessionsOpened: new Set(),
  });
  log.info({ ip, email }, '[ws] open');
  // Mark as alive so the keepalive timer doesn't kill us before we've
  // had a chance to be pinged once. Each subsequent pong flips it back
  // to true; missed pings flip it to false and then terminate.
  wsAlive.set(ws, true);
  ws.on('pong', () => wsAlive.set(ws, true));
  // Tell the client who it is and where it's coming from — frontend
  // displays this in the bottom #info-bar. user/host let the bottom bar
  // render a Claude-Code-style `user@host:cwd` status line.
  ws.send(JSON.stringify({
    type: 'connection-info',
    ip,
    email,
    user: os.userInfo().username,
    host: os.hostname(),
  }));

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      bumpUp(ws, buf.length);
      handleBinary(ws, buf);
      return;
    }
    // Text frame: JSON control message.
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(data as ArrayBuffer).toString('utf8');
    bumpUp(ws, Buffer.byteLength(text, 'utf8'));
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      log.warn(`[ctrl] non-JSON text frame, dropped: ${text.slice(0, 80)}`);
      sendError(ws, 'malformed', 'text frames must be JSON');
      return;
    }
    handleControl(ws, msg).catch((err: unknown) => {
      log.error({ err }, '[ctrl] handler threw');
      sendError(ws, 'internal', 'control handler error');
    });
  });

  ws.on('close', (code, reason) => {
    const subs = Array.from(wsSubs.get(ws) ?? []);
    const ups = Array.from(wsUploadIds.get(ws) ?? []);
    const acct = wsAccount.get(ws);
    log.info({
      ip: acct?.ip,
      email: acct?.email,
      code,
      reason: reason.toString() || undefined,
      durationMs: acct ? Date.now() - acct.openedAt : undefined,
      sessionsOpened: acct ? Array.from(acct.sessionsOpened) : [],
      bytesUp: acct?.bytesUp,
      bytesDown: acct?.bytesDown,
      activeSubs: subs.length,
      activeUploads: ups.length,
    }, '[ws] close');
    for (const id of subs) detachWsFromSession(ws, id, 'ws-closed');
    for (const uploadId of ups) void dropUpload(uploadId, 'ws-closed');
    wsAccount.delete(ws);
  });

  ws.on('error', (err) => {
    log.error({ err }, '[ws] error');
  });
});

server.listen(PORT, HOST, () => {
  log.info(`terminalcat listening on http://${HOST}:${PORT}`);
  // Best-effort: turn on tmux's mouse mode so scrolling inside tmux moves
  // tmux's scrollback instead of sending ↑/↓ to the inner shell. Idempotent
  // and silent if no tmux server is running yet — first session-spawn
  // re-runs this.
  void ensureTmuxMouseOn();
  // Mouse-selection UX: by default tmux clears the highlight the moment
  // you release the drag. Rebind to keep it visible.
  void keepTmuxSelectionAfterDrag();
  // Bridge tmux's copy buffer to the browser's clipboard via OSC 52.
  // Without this, drag-copy lands only in tmux's internal buffer and
  // can't be pasted into anything outside the terminal.
  void enableTmuxClipboard();
  // tabs are our multiplexing UI — disable tmux's own split-pane keys so
  // accidentally hitting Ctrl-b % doesn't create a pane the user can't
  // reach via the tab bar.
  void disableTmuxSplits();
  // Right-click in the terminal area should show OUR browser-level menu,
  // not tmux's display-menu. Without this, both menus stack on right-click.
  void disableTmuxRightClickMenu();
  // We replace tmux's own green status bar with our own #info-bar in the
  // frontend, which can show client IP / device count / etc. that tmux
  // doesn't know about.
  void disableTmuxStatus();
});

// === shim socket (webdl / webnotify) =====================================
// CLI shims write a JSON line; we route to the right WS subscribers.
const stopShim = startShimService({
  onDownload: (req) => performDownload(req),
  onNotify:   (req) => performNotify(req),
});

// Graceful shutdown.
//
//   1. Stop the shim socket (so a `webdl` invocation in flight gets
//      a clean disconnect rather than a hang).
//   2. Close every WS with code 1001 ("going away") + a reason string —
//      browsers see this and our auto-reconnect handler kicks in cleanly
//      when the next instance comes up.
//   3. SIGHUP every PTY child so tmux *clients* detach. tmux *server*
//      and the sessions themselves are not killed — they outlive us.
//   4. Best-effort delete of any partial-upload temp files so we don't
//      leave half-written `.uploading` files behind.
//   5. server.close() — stop accepting new connections, drain in flight.
//   6. Hard exit deadline 5s. Anything still running at that point gets
//      cut off; running too long here delays systemd's restart cycle.
const shutdown = (sig: string): void => {
  log.info({ sig }, '[server] shutdown begin');
  stopShim();
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch { /* gone */ }
  }
  for (const [id, a] of active) {
    log.info({ session: id }, '[server] SIGHUP pty');
    try { a.pty.kill('SIGHUP'); } catch { /* dead */ }
  }
  for (const u of uploads.values()) void cleanupUpload(u);
  server.close(() => {
    log.info('[server] http closed cleanly');
    process.exit(0);
  });
  // Hard deadline so a stuck close doesn't keep the process alive
  // forever. .unref() so the timer alone doesn't extend lifetime.
  setTimeout(() => {
    log.warn('[server] shutdown timeout — forcing exit');
    process.exit(1);
  }, 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
