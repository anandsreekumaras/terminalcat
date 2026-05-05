# terminalcat WebSocket protocol — v2.1

Single bidirectional WebSocket. Two frame *types*, distinguished by the WS frame
type itself:

| WS frame | What it carries          | Direction       |
|----------|--------------------------|-----------------|
| `text`   | JSON control messages    | both directions |
| `binary` | tagged data frames       | both directions |

A message that doesn't parse is dropped with a server log line — the connection
is not killed (drop one bad frame, keep going).

## Binary data frames

Outer frame:

```
+------+----------+---------------+----------------+
| tag  | sidLen   | sessionId     | payload        |
| 1 B  | 1 B      | sidLen bytes  | rest of frame  |
+------+----------+---------------+----------------+
```

- `tag` (1 B): which logical channel.
- `sidLen` (1 B): byte length of `sessionId`.
- `sessionId` (UTF-8): `^[a-zA-Z0-9_-]{1,64}$`.
- `payload`: raw bytes for the channel.

### Tags

| tag  | name             | dir  | payload meaning                          |
|------|------------------|------|------------------------------------------|
| 0x01 | `STDIN`          | C→S  | bytes written into the PTY's stdin       |
| 0x02 | `STDOUT`         | S→C  | bytes read from the PTY's stdout         |
| 0x03 | `FILE_UP_CHUNK`  | C→S  | upload chunk (see file payload below)    |
| 0x04 | `FILE_DOWN_CHUNK`| S→C  | download chunk (see file payload below)  |

### File chunk payload (tags 0x03 / 0x04)

The payload of a file chunk is:

```
+--------+-----------+----------+--------+
| idLen  | transferId| seq (BE) | bytes  |
| 1 B    | idLen B   | 4 B      | rest   |
+--------+-----------+----------+--------+
```

- `transferId`: server-assigned, uploadId for 0x03 / downloadId for 0x04.
- `seq` (uint32 BE, starting at 0): per-transfer monotonic chunk index.
  WebSocket already preserves order on a single connection, so `seq` is
  belt-and-suspenders — server asserts strict monotonic increase and
  drops the transfer otherwise.

## JSON control messages

### Session lifecycle (client → server)

```jsonc
{ "type": "session-list" }
{ "type": "session-open",   "id": "work" }
{ "type": "session-close",  "id": "work" }
{ "type": "session-kill",   "id": "work" }
{ "type": "session-rename", "id": "work", "newId": "scratch" }
{ "type": "session-cwd",    "id": "work" }   // ask for the pane's cwd
{ "type": "resize", "sessionId": "work", "cols": 120, "rows": 40 }

// Toggle tmux's global `mouse` option. on=true: scroll wheel scrolls
// tmux's scrollback (selection requires Shift+click+drag).
// on=false: xterm.js owns the mouse — selection works without Shift,
// scroll wheel becomes ↑/↓ keys.
{ "type": "tmux-mouse", "on": true }
```

### Session lifecycle (server → client)

```jsonc
{ "type": "session-list", "sessions": [{"id":"work","createdAt":1714836097,"attached":true}] }
{ "type": "session-opened",  "id": "work" }
{ "type": "session-closed",  "id": "work", "reason": "detached" | "pty-exit" | "ws-closed" | "killed" }
{ "type": "session-killed",  "id": "work" }
{ "type": "session-renamed", "oldId": "work", "newId": "scratch" }
{ "type": "session-cwd",     "id": "work", "cwd": "/home/ubuntu/work" }

// Sent on every WS open. Lets the frontend show "you are <user> from
// 1.2.3.4" in the bottom info bar. `email` is read from the verified
// JWT — never the unsigned Cf-Access-Authenticated-User-Email header.
{ "type": "connection-info", "ip": "203.0.113.42", "email": "you@example.com" }

// Live count of WebSocket subscribers attached to a session. Pushed
// whenever someone joins or leaves. Frontend renders "N devices" in the
// bottom info bar.
{ "type": "session-clients", "id": "work", "count": 2 }

// Reply to `tmux-mouse`.
{ "type": "tmux-mouse-state", "on": true }

{ "type": "error", "code": "...", "message": "..." }
```

### File upload (client → server)

```jsonc
// Step 1: announce intent. Server validates name, resolves target dir from
// `tmux display-message -p '#{pane_current_path}' -t <sessionId>`, checks
// concurrency limits, and replies `upload-ready` or `upload-rejected`.
//
//  - `name`: basename only (no /, \, .., null bytes; leading dot rejected
//            unless `allowDot:true`).
//  - `size`: declared size in bytes (server still counts and aborts on
//            overrun — never trust client size).
//  - `mode`: octal string for the final chmod, e.g. "0644". Optional;
//            defaults to 0644.
{ "type": "upload-start", "sessionId": "work", "name": "data.tar.gz", "size": 12345, "mode": "0644" }

// Step 2: stream chunks tagged 0x03, with the issued uploadId.
//   (sent as binary FILE_UP_CHUNK frames; see "File chunk payload" above)

// No explicit "end" — server detects completion when bytesReceived === size.
```

### File upload (server → client)

```jsonc
{ "type": "upload-ready",    "uploadId": "u_abc", "path": "/home/ubuntu/work/data.tar.gz" }
{ "type": "upload-rejected", "code": "...", "message": "..." }
{ "type": "upload-progress", "uploadId": "u_abc", "received": 1048576 }
{ "type": "upload-complete", "uploadId": "u_abc", "path": "/home/ubuntu/work/data.tar.gz" }
{ "type": "upload-failed",   "uploadId": "u_abc", "code": "...", "message": "..." }
```

Server-side limits (defaults; configurable in `src/upload.ts`):
- `MAX_SIZE`: 500 MiB per file
- `MAX_PER_SESSION_CONCURRENT`: 1
- `MAX_PER_WS_CONCURRENT`: 5
- Chunk size client-side: 64 KiB

If a client streams more bytes than the announced `size`, the upload is
aborted, the partial file deleted, and `upload-failed{code:"size-overflow"}`
sent. Same on WS disconnect mid-upload (partial deleted; no half-written
state on disk).

### File download (server → client)

Initiated by a CLI shim (`webdl`) running inside a session. The shim writes
a JSON line to a UNIX socket the server listens on; the server then pushes
the file as `download-*` control messages plus FILE_DOWN_CHUNK frames to
the active WS subscriber(s) of that session.

```jsonc
{ "type": "download-start",    "downloadId": "d_xyz", "sessionId": "work", "name": "report.pdf", "size": 234567 }
{ "type": "download-progress", "downloadId": "d_xyz", "sent": 65536 }
{ "type": "download-complete", "downloadId": "d_xyz" }
{ "type": "download-failed",   "downloadId": "d_xyz", "code": "...", "message": "..." }
```

The frontend assembles chunks into a `Blob` and triggers a browser download
via a synthetic `<a download>` click. On mobile this lands in iOS Files /
Android's Downloads.

### Notify (server → client)

Initiated by the `webnotify "<message>"` CLI shim. Forwarded to every WS
subscriber of the session as:

```jsonc
{ "type": "notify", "sessionId": "work", "message": "scan finished" }
```

Frontend may use `Notification` API (with permission) to surface OS-level
notifications when the page is backgrounded.

## Lifecycle

1. Client opens WS. Auth at the upgrade handshake (Cloudflare Access JWT).
2. Client sends `session-list`, gets state, sends `session-open` per tab.
3. STDIN/STDOUT flow as binary 0x01/0x02 frames.
4. Per-session resize via `resize` control message.
5. On WS close: server detaches WS from all sessions; if a session has
   zero subscribers left, the server-side PTY child is SIGHUP/SIGKILL'd
   (tmux session itself survives).

## Reserved / out of scope

- Heartbeat / keepalive — WebSocket protocol pings handle this.
- File transfer integrity hash — neither uploads nor downloads carry one
  in v1. Files are reassembled by length; if you need integrity check the
  hash yourself after transfer.
