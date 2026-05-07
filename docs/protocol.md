---
title: Protocol
layout: default
nav_order: 8
---

# Wire protocol
{: .no_toc }

How the client and origin actually talk.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Channel split

Every WebSocket frame is one of two channels:

| Frame type | Carrier | Payload |
|---|---|---|
| **Text** | JSON | Control messages — `resize`, `session-list`, `upload-start`, `ping`, … |
| **Binary** | Tagged | Stream data — stdin, stdout, file chunks |

The split is deliberate: the small set of control messages benefit from
human-readable JSON; the high-volume data path benefits from minimal
header overhead.

Compression (`permessage-deflate`) is **disabled** — PTY bytes are
already-compact ANSI/UTF-8 and DEFLATE just adds CPU.

## Binary frame layout

```
 0       1         2                          2+sidLen
 ┌───────┬─────────┬─────────────────────────┬────────────────────────┐
 │  tag  │ sidLen  │   sessionId (UTF-8)     │    payload (M bytes)   │
 │ 1 B   │  1 B    │   N bytes (1..64)       │                        │
 └───────┴─────────┴─────────────────────────┴────────────────────────┘
```

| Field | Description |
|---|---|
| `tag` | one of: `0x01` STDIN, `0x02` STDOUT, `0x03` FILE_UP_CHUNK, `0x04` FILE_DOWN_CHUNK |
| `sidLen` | byte length of `sessionId` (1..64) |
| `sessionId` | UTF-8 string matching `^[a-zA-Z0-9_-]{1,64}$` |
| `payload` | tag-specific body |

`sidLen == 0` is invalid (silently dropped). Frames smaller than `2 + sidLen` are malformed (also dropped, no body, `[data] malformed frame` warning logged).

### File-chunk inner payload

`FILE_UP_CHUNK` and `FILE_DOWN_CHUNK` carry an inner header inside the payload:

```
 0       1                idLen+1   idLen+5
 ┌───────┬──────────────┬─────────┬───────────────┐
 │ idLen │ transferId   │ seq:4 BE│  bytes (M)    │
 │ 1 B   │ idLen bytes  │  4 B    │               │
 └───────┴──────────────┴─────────┴───────────────┘
```

Sequence numbers are strictly monotonic per upload (`seq` must equal the
server's `expectedSeq`; mismatch → upload is dropped with an error).

## Control messages

JSON discriminated union on `type`. Schemas in [`src/schema.ts`](https://github.com/anandsreekumaras/terminalcat/blob/main/src/schema.ts).

### Client → server

| `type` | Fields | Effect |
|---|---|---|
| `resize` | `sessionId`, `cols` (2..1000), `rows` (2..1000) | `pty.resize(cols, rows)` |
| `session-list` | (none) | server replies with `session-list` listing all tmux sessions |
| `session-open` | `id` | attach this WS to session `id`; spawn the PTY child if no other WS is attached |
| `session-close` | `id` | detach (does NOT kill the tmux session) |
| `session-kill` | `id` | `tmux kill-session -t id` |
| `session-rename` | `id`, `newId` | renames the tmux session, mutates server state, broadcasts to all subscribers |
| `session-cwd` | `id` | server replies with `session-cwd { id, cwd }` |
| `tmux-mouse` | `on: bool` | toggles tmux mouse mode globally |
| `upload-start` | `sessionId`, `name`, `size`, `mode?` | start a new upload; server replies with `upload-ready { uploadId, path }` or `upload-rejected` |
| `ping` | `t?: number` | server replies `pong` (echoes `t` if provided) — used by the visibility probe |

### Server → client

| `type` | Fields | When |
|---|---|---|
| `connection-info` | `ip`, `email`, `user`, `host` | sent once on WS open |
| `session-list` | `sessions: [{ id, createdAt, attached }]` | reply to `session-list` |
| `session-clients` | `id`, `count` | broadcast when subscriber count changes |
| `session-opened` | `id` | reply to `session-open` |
| `session-closed` | `id`, `reason` | broadcast when last subscriber detaches OR PTY exits |
| `session-killed` | `id` | reply to `session-kill` |
| `session-renamed` | `oldId`, `newId` | broadcast |
| `session-cwd` | `id`, `cwd` | reply to `session-cwd` |
| `tmux-mouse-state` | `on` | reply to `tmux-mouse` |
| `upload-ready` | `uploadId`, `path` | accepted `upload-start` |
| `upload-rejected` | `code`, `message` | rejected `upload-start` (invalid name, oversize, no-cwd, …) |
| `upload-progress` | `uploadId`, `received` | every ~16 chunks |
| `upload-complete` | `uploadId`, `path` | all bytes received, file finalized |
| `upload-failed` | `uploadId`, `code`, `message` | mid-upload error or disconnect |
| `download-start` | `downloadId`, `name`, `size`, `sessionId` | server-initiated (from the `webdl` shim) |
| `download-progress` | `downloadId`, `sent` | progress |
| `download-complete` | `downloadId` | done |
| `download-failed` | `downloadId`, `code`, `message` | error |
| `notify` | `message`, `sessionId` | from the `webnotify` shim |
| `pong` | `t?: number` | reply to `ping` |
| `error` | `code`, `message` | structured error reply (malformed control msg, unknown type, etc.) |

## Auth-time invariants

- `Cf-Connecting-Ip` must be present on every HTTP request and WS upgrade
- `Cf-Access-Jwt-Assertion` must verify against Cloudflare's JWKS for the configured `<TEAM>.cloudflareaccess.com`
- `aud` claim must equal `CF_ACCESS_AUD`
- `iss` claim must equal `https://<CF_ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`
- `email` and `sub` claims must be present (rejects M2M service tokens)
- (Optional, when `ALLOWED_ORIGIN` is set) WS upgrade `Origin` must match if present

Failure on any of the above ends the request: `401` for HTTP, hand-rolled
401-or-403 + `socket.destroy()` for WS.

## Wire-level limits

| Limit | Value | Where |
|---|---|---|
| Max single inbound frame | 4 MiB | `WebSocketServer({ maxPayload })` — pastes chunk to stay under |
| Max upload total size | 500 MiB | `MAX_UPLOAD_SIZE` in `src/upload.ts` |
| Max concurrent uploads per session | 1 | `MAX_UPLOADS_PER_SESSION` |
| Max concurrent uploads per WS | 5 | `MAX_UPLOADS_PER_WS` |
| Session id length | 64 chars | regex `^[a-zA-Z0-9_-]{1,64}$` |
| Upload chunk size (client side) | 64 KiB | `PASTE_CHUNK` in `public/index.html` |
| Cols / rows | 2..1000 | zod-enforced |

## Full spec

The canonical version with edge cases lives at [`PROTOCOL.md`](https://github.com/anandsreekumaras/terminalcat/blob/main/PROTOCOL.md) in the repo.
