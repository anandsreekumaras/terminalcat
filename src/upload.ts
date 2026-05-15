// File upload state machine + path sanitiser.
//
// The flow (see PROTOCOL.md):
//   1. Client sends `upload-start{sessionId,name,size,mode?}`
//   2. We validate name, ask tmux for the session's pane_current_path,
//      check disk + concurrency limits, open <target>.uploading for write,
//      reply `upload-ready{uploadId, path}`.
//   3. Client streams FILE_UP_CHUNK frames. We assert seq is strictly
//      monotonic (catches client bugs even though WS preserves order),
//      append to the temp file, count bytes.
//   4. When bytesReceived === announced size, fsync, fchmod, rename,
//      print `[uploaded foo.tar.gz to /path/]` into the session's stdout,
//      reply `upload-complete{uploadId, path}`.
//   5. Any error / WS disconnect mid-upload: close fd, unlink temp file,
//      reply `upload-failed`. No half-written state on disk.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { errMsg } from './errors';
import { isValidSessionId } from './protocol';

export const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;        // 500 MiB
export const MAX_UPLOADS_PER_SESSION = 1;
export const MAX_UPLOADS_PER_WS = 5;

export interface UploadStartArgs {
  sessionId: string;
  name: string;
  size: number;
  mode?: string;   // octal string, e.g. "0644"
}

export interface UploadRejected {
  ok: false;
  code:
    | 'invalid-session-id'
    | 'invalid-name'
    | 'invalid-size'
    | 'invalid-mode'
    | 'concurrency-session'
    | 'concurrency-ws'
    | 'no-session-cwd'
    | 'cwd-stat-failed'
    | 'target-exists'
    | 'open-failed';
  message: string;
}
export interface UploadAccepted {
  ok: true;
  upload: Upload;
}
export type UploadStartResult = UploadAccepted | UploadRejected;

export interface Upload {
  id: string;
  sessionId: string;
  name: string;
  finalPath: string;
  tmpPath: string;
  expectedSize: number;
  bytesReceived: number;
  expectedSeq: number;
  mode: number;
  fd: fs.promises.FileHandle;
  /** Wall-clock when the upload was issued (used by an inactivity sweeper). */
  startedAt: number;
  /** Wall-clock of the most recent successful chunk write (sweeper input). */
  lastActivityAt: number;
  /**
   * Set synchronously inside appendChunk the moment we know the final
   * chunk has arrived (bytesReceived will hit expectedSize), BEFORE any
   * await for fsync/close/rename. Callers must check this on every chunk
   * dispatch — see server.ts FILE_UP_CHUNK handler — so a stray chunk
   * arriving during the async finalise window doesn't get fed into a
   * closed fd. Closes the race between "appendChunk returns done" and
   * "server deletes from uploads map".
   */
  completed: boolean;
}

/**
 * Strict basename sanitizer. Rejects path separators, traversal, control
 * bytes, and dotfiles by default. Caller must still resolve & startsWith
 * the target dir.
 */
export function sanitizeName(name: unknown, allowDot = false): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof name !== 'string') return { ok: false, reason: 'name must be string' };
  if (name.length === 0) return { ok: false, reason: 'name empty' };
  if (name.length > 255) return { ok: false, reason: 'name too long' };
  if (name.includes('\0')) return { ok: false, reason: 'name has NUL byte' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, reason: 'name has path separator' };
  // Reject control bytes: C0 (0x01..0x1F) and DEL (0x7F).
  // Earlier the check was just `< 0x20`, which let DEL (and the C1 range
  // 0x80..0x9F via UTF-8 in some interpretations) through. They don't
  // enable traversal but they confuse `ls`, completion, and downstream
  // scripts — easier to reject than to think about.
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c === 0x7F) {
      return { ok: false, reason: `name has control byte 0x${c.toString(16)}` };
    }
  }
  if (name === '.' || name === '..') return { ok: false, reason: 'name reserved' };
  // Leading-dot check, after trimming leading whitespace. Earlier just
  // `name.startsWith('.')` — that let " .ssh-evil" (note leading space)
  // through, which doesn't actually shadow `.ssh` (different filename)
  // but is the kind of confusing-name we'd rather not produce.
  if (!allowDot) {
    const trimmed = name.replace(/^\s+/, '');
    if (trimmed.startsWith('.')) {
      return { ok: false, reason: 'leading dot not allowed' };
    }
  }
  return { ok: true, name };
}

/**
 * Ask tmux for a session's pane_current_path. Returns absolute path or null
 * (session missing / tmux error). Stat-checks that it's an existing dir.
 */
export function getSessionCwd(sessionId: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!isValidSessionId(sessionId)) { resolve(null); return; }
    const child = spawn('tmux', ['display-message', '-p', '-t', sessionId, '#{pane_current_path}']);
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const cwd = out.trim();
      if (!cwd || !path.isAbsolute(cwd)) { resolve(null); return; }
      resolve(cwd);
    });
  });
}

function newId(prefix: 'u' | 'd'): string {
  return prefix + '_' + randomBytes(6).toString('hex');
}

function parseMode(mode: string | undefined): number | null {
  if (mode === undefined) return 0o644;
  if (typeof mode !== 'string' || !/^0?[0-7]{3,4}$/.test(mode)) return null;
  // strip leading 0 to avoid double-octal weirdness; parseInt with radix 8.
  return parseInt(mode, 8) & 0o7777;
}

/**
 * Begin an upload — validates everything and opens the temp file. Returns
 * either the Upload object (caller should remember and route chunks to it)
 * or a typed rejection.
 *
 * Caller is responsible for:
 *   - tracking concurrency limits (counts per WS / session) BEFORE calling.
 *     We accept those counters as args so the caller stays the source of truth.
 *   - rolling back on later errors via cleanupUpload().
 */
export async function startUpload(
  args: UploadStartArgs,
  perWsCount: number,
  perSessionCount: number,
): Promise<UploadStartResult> {
  if (!isValidSessionId(args.sessionId)) {
    return { ok: false, code: 'invalid-session-id', message: 'session id invalid' };
  }
  const named = sanitizeName(args.name);
  if (!named.ok) {
    return { ok: false, code: 'invalid-name', message: named.reason };
  }
  if (typeof args.size !== 'number' || !Number.isFinite(args.size) || args.size < 0 || args.size > MAX_UPLOAD_SIZE || !Number.isInteger(args.size)) {
    return { ok: false, code: 'invalid-size', message: `size must be 0..${MAX_UPLOAD_SIZE}` };
  }
  const mode = parseMode(args.mode);
  if (mode === null) {
    return { ok: false, code: 'invalid-mode', message: 'mode must look like "0644"' };
  }
  if (perSessionCount >= MAX_UPLOADS_PER_SESSION) {
    return { ok: false, code: 'concurrency-session', message: `max ${MAX_UPLOADS_PER_SESSION} concurrent upload per session` };
  }
  if (perWsCount >= MAX_UPLOADS_PER_WS) {
    return { ok: false, code: 'concurrency-ws', message: `max ${MAX_UPLOADS_PER_WS} concurrent uploads per WS` };
  }

  const cwd = await getSessionCwd(args.sessionId);
  if (!cwd) {
    return { ok: false, code: 'no-session-cwd', message: `couldn't get cwd for session "${args.sessionId}"` };
  }
  // Confirm cwd is a real dir.
  try {
    const st = await fs.promises.stat(cwd);
    if (!st.isDirectory()) {
      return { ok: false, code: 'cwd-stat-failed', message: `${cwd} is not a directory` };
    }
  } catch (err) {
    return { ok: false, code: 'cwd-stat-failed', message: errMsg(err) };
  }

  const finalPath = path.resolve(cwd, named.name);
  // Defense-in-depth: even though sanitizeName forbids separators, confirm
  // the resolved path is actually inside cwd.
  const cwdResolved = path.resolve(cwd) + path.sep;
  if (finalPath !== path.resolve(cwd) && !finalPath.startsWith(cwdResolved)) {
    return { ok: false, code: 'invalid-name', message: 'resolved path escapes cwd' };
  }

  // Reject if final exists. Caller can extend this later with a "confirm
  // overwrite" round-trip if desired.
  try {
    await fs.promises.access(finalPath, fs.constants.F_OK);
    return { ok: false, code: 'target-exists', message: `${finalPath} already exists` };
  } catch { /* ENOENT — good */ }

  const tmpPath = finalPath + '.uploading';
  // Open exclusive — refuse to clobber an in-flight temp from another
  // upload of the same name.
  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(tmpPath, 'wx', mode);
  } catch (err) {
    return { ok: false, code: 'open-failed', message: `${tmpPath}: ${errMsg(err)}` };
  }

  const now = Date.now();
  const upload: Upload = {
    id: newId('u'),
    sessionId: args.sessionId,
    name: named.name,
    finalPath,
    tmpPath,
    expectedSize: args.size,
    bytesReceived: 0,
    expectedSeq: 0,
    mode,
    fd,
    startedAt: now,
    lastActivityAt: now,
    completed: false,
  };
  return { ok: true, upload };
}

/**
 * Append a chunk. Returns:
 *   - { done: true, path }  when the upload is fully received & renamed.
 *   - { done: false }       to keep going.
 *   - { error: ... }        on any fatal: caller must drop the upload.
 */
export type ChunkResult =
  | { done: false }
  | { done: true; path: string }
  | { error: string };

export async function appendChunk(upload: Upload, seq: number, data: Buffer): Promise<ChunkResult> {
  if (upload.completed) {
    // Completion was already detected synchronously — fd is being closed
    // or has been closed. Drop quietly; the caller's `if (upload.completed)`
    // check normally catches this first, but belt-and-braces.
    return { error: 'upload already completed' };
  }
  if (seq !== upload.expectedSeq) {
    return { error: `seq mismatch: got ${seq}, expected ${upload.expectedSeq}` };
  }
  upload.expectedSeq++;

  const next = upload.bytesReceived + data.length;
  if (next > upload.expectedSize) {
    return { error: `size overflow: declared ${upload.expectedSize}, would be ${next}` };
  }
  // Mark the final chunk synchronously, BEFORE the first await. Any
  // chunk frame the server happens to dispatch into appendChunk during
  // the upcoming fsync/close/rename will hit the `upload.completed`
  // guard above and bail out cleanly instead of trying to fd.write
  // into a closed handle.
  const isFinal = next === upload.expectedSize;
  if (isFinal) upload.completed = true;

  try {
    await upload.fd.write(data);
  } catch (err) {
    return { error: `write failed: ${errMsg(err)}` };
  }
  upload.bytesReceived = next;
  upload.lastActivityAt = Date.now();

  if (isFinal) {
    try {
      await upload.fd.sync();
      await upload.fd.close();
      // chmod was applied at open via the third arg, but umask may have
      // masked some bits. fchmod the final path to the requested mode.
      await fs.promises.chmod(upload.tmpPath, upload.mode);
      await fs.promises.rename(upload.tmpPath, upload.finalPath);
      return { done: true, path: upload.finalPath };
    } catch (err) {
      return { error: `finalise failed: ${errMsg(err)}` };
    }
  }
  return { done: false };
}

/** Best-effort cleanup. Call on rejection, error, or WS disconnect. */
export async function cleanupUpload(upload: Upload): Promise<void> {
  try { await upload.fd.close(); } catch { /* already closed */ }
  try { await fs.promises.unlink(upload.tmpPath); } catch { /* already gone */ }
}
