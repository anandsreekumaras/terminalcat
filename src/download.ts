// UNIX-socket service for the `webdl` and `webnotify` CLI shims.
//
// Why a UNIX socket and not stdout escapes (the trzsz/zmodem path):
//   - Parsing escape sequences out of a live PTY stream is fragile —
//     prone to TUI app collisions, copy/paste corruption, etc.
//   - A side-channel is unambiguous: shim writes a JSON line to a
//     local socket, server reads it, server pushes the file (or
//     notification) to the right WS subscribers.
//
// Auth: the socket lives at $XDG_RUNTIME_DIR/terminalcat.sock if the
// runtime dir is set, else /tmp/terminalcat-<uid>.sock. Permission 0600.
// Single-tenant box: anyone with the user's shell can use webdl. That
// matches the trust boundary of the rest of the project.

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { errMsg } from './errors';

export interface DownloadRequest {
  action: 'download';
  sessionId: string;
  path: string;
}

export interface NotifyRequest {
  action: 'notify';
  sessionId: string;
  message: string;
}

export type ShimRequest = DownloadRequest | NotifyRequest;

export type ShimReply =
  | { ok: true; result?: unknown }
  | { ok: false; error: string };

export interface ShimHandlers {
  onDownload(req: DownloadRequest): Promise<ShimReply>;
  onNotify(req: NotifyRequest): Promise<ShimReply>;
}

export function shimSocketPath(): string {
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (xdg && fs.existsSync(xdg)) {
    return path.join(xdg, 'terminalcat.sock');
  }
  // os.userInfo().uid is undefined on Windows; we don't run there.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join('/tmp', `terminalcat-${uid}.sock`);
}

/**
 * Start the shim socket service. Returns a function to close it. Cleans
 * up the socket file on close. If the socket file already exists (stale
 * from a previous run), we unlink and rebind — single-tenant.
 */
export function startShimService(handlers: ShimHandlers): () => void {
  const sockPath = shimSocketPath();
  try { fs.unlinkSync(sockPath); } catch { /* not there — fine */ }

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // Process complete lines; ignore trailing partial.
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (line.trim().length > 0) handleLine(line).catch((err) => {
          console.error('[shim] handler threw:', err);
        });
      }
    });
    conn.on('error', () => { /* swallow; client may have hung up */ });

    async function handleLine(line: string): Promise<void> {
      let req: ShimRequest;
      try { req = JSON.parse(line) as ShimRequest; }
      catch {
        replyAndEnd({ ok: false, error: 'request must be a single JSON line' });
        return;
      }
      let reply: ShimReply;
      try {
        if (req.action === 'download') {
          reply = await handlers.onDownload(req);
        } else if (req.action === 'notify') {
          reply = await handlers.onNotify(req);
        } else {
          reply = { ok: false, error: `unknown action: ${(req as { action: string }).action}` };
        }
      } catch (err) {
        reply = { ok: false, error: errMsg(err) };
      }
      replyAndEnd(reply);
    }

    function replyAndEnd(reply: ShimReply): void {
      try { conn.write(JSON.stringify(reply) + '\n'); } catch { /* gone */ }
      try { conn.end(); } catch { /* gone */ }
    }
  });

  server.on('error', (err) => {
    console.error('[shim] server error:', err);
  });

  server.listen(sockPath, () => {
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best-effort */ }
    console.log(`[shim] listening on ${sockPath}`);
  });

  return () => {
    try { server.close(); } catch { /* */ }
    try { fs.unlinkSync(sockPath); } catch { /* */ }
  };
}

/** os.userInfo wrapped — used by bin/webdl/webnotify (CLI side) too. */
export function userInfo(): os.UserInfo<string> {
  return os.userInfo();
}
