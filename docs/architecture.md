---
title: Architecture
layout: default
nav_order: 4
---

# Architecture
{: .no_toc }

How the bytes flow, why each layer is there, and what each defense buys you.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## The diagram

![terminalcat architecture diagram](./assets/architecture.svg)

## Layers, top to bottom

### 1. Browser / PWA

`xterm.js` v6 with WebGL renderer (canvas fallback). Single HTML file, no
bundler in v1 — CDN-loaded. A pass-through service worker is registered
solely so the browser counts the page as a PWA (Chrome's install criteria
require *a* `fetch` listener). The SW does not cache anything itself —
caching is on a per-extension `Cache-Control` policy at the origin instead;
see [Operations → Caching](./operations.html#caching) for why.

The frontend speaks the protocol described in [Protocol](./protocol.html):

- **stdin** as binary WS frames tagged 0x01
- **control messages** as JSON text frames
- **upload chunks** as binary frames tagged 0x03 with an inner `[idLen][id][seq][bytes]` payload

### 2. Cloudflare Access (edge)

The first time you load the URL, you're 302'd to your team's
`<TEAM>.cloudflareaccess.com/cdn-cgi/access/login/...` SSO flow. After
authenticating against your IdP (or a one-time PIN to your email), CF Access
sets a session cookie and from that point onward injects two headers on
every request that reaches your origin:

- `Cf-Access-Jwt-Assertion`: a signed RS256 JWT with claims `iss`, `aud`,
  `exp`, `iat`, `email`, `sub`. Issuer = `https://<TEAM>.cloudflareaccess.com`.
  Audience = the AUD tag of your Access app.
- `Cf-Connecting-Ip`: the real client IP (Cloudflare-set; unsigned, used only as
  a presence heuristic at the origin).

Logout = clearing the cookie via the `cdn-cgi/access/logout` endpoint.

### 3. cloudflared tunnel (your box)

A persistent **outbound** QUIC connection from your VPS to Cloudflare's edge.
Four POPs registered for redundancy. Cloudflare proxies inbound traffic for
your hostname into this tunnel, terminating TLS at their edge.

The tunnel runs as a systemd service (`cloudflared-terminalcat.service`)
distinct from the package-default `cloudflared.service`, so it sits cleanly
alongside any other tunnels you have on the box.

**There is no inbound port on your VPS.** Loopback bind (next layer) is
literally enforced — the origin would refuse to start if `HOST !== '127.0.0.1'`.

### 4. terminalcat origin (`127.0.0.1:7682`)

Node 20, TypeScript strict, no framework. Single process, single user.
Ships as `tsx src/server.ts` for dev or compiled `node dist/server.js` for
production via `pnpm build`.

The handler chain on every request:

1. **HTTP**: auth gate → static handler (with ETag + per-extension cache headers + SPA fallback). Auth runs first; failed auth returns 401 *before* the static handler sees the path, so the traversal sandbox is unreachable from outside.
2. **WS upgrade**: auth gate (with optional `ALLOWED_ORIGIN` allowlist for CSWSH defense) → `wss.handleUpgrade` → multiplexer.

Defenses in layered order (intentionally redundant):

| Layer | What it gates |
|---|---|
| 127.0.0.1 bind (hard-checked at startup) | Anything reaching this socket already came through cloudflared on this box |
| `Cf-Connecting-Ip` presence | Heuristic that the request was routed via Cloudflare |
| JWT verify (`jose`, JWKS cached 1h) | The actual auth — RS256 sig + aud + iss + exp |
| `Origin` allowlist (optional, on by env) | CSWSH defense for the SameSite=None cookie edge case |

Identity used by logs and per-WS accounting is only the JWT's `email` claim.
The unsigned `Cf-Access-Authenticated-User-Email` header is **never** trusted.

### 5. WebSocket multiplexer

One WS connection can subscribe to N tmux sessions. The server keeps an
`active: Map<sessionId, ActivePty>` where each entry has the node-pty handle
and a `Set<WebSocket>` of subscribers. Outputs from a PTY broadcast to every
subscriber's WS as a tagged binary frame.

`session-rename` mutates `entry.id` in place; the WeakMap-keyed pending-output
buffer (used when `OUTPUT_BATCH_MS > 0`) doesn't desync because the entry
*identity* doesn't change.

`session-close` detaches a WS from a session (subscribers count drops). When
`subscribers.size === 0`, the node-pty child is SIGHUP'd. The tmux server
keeps the underlying session running; reattach respawns the PTY child.

`session-kill` actually destroys the tmux session via `tmux kill-session -t`.

### 6. node-pty

One PTY child per attached session. Spawned with `tmux new -A -s <id>` —
the `-A` flag attaches if the session already exists. The PTY child is the
**tmux client**, never the inner shell directly. That's the whole reason
disconnects don't kill processes:

- WS close → server SIGHUPs the PTY child (the tmux client)
- The tmux client receives SIGHUP and detaches gracefully
- The tmux server, your bash, your nuclei scan, all keep running

Spawned with `encoding: null` so the onData callback hands us raw `Buffer`
chunks instead of UTF-8 strings — saves a decode/re-encode round-trip on
the hot path.

### 7. tmux server (PPID=1)

The persistence anchor. Started by the first `tmux new` and daemonized with
PPID=1; outlives Node restarts, cloudflared restarts, even `systemctl stop`.
Source of truth for "which sessions exist" — the server queries
`tmux list-sessions` (parsed by `src/sessions.ts`), not its own in-memory map.

Configured at startup by `src/sessions.ts`:
- mouse mode on (drag-to-select, click cancels copy-mode)
- status bar disabled (replaced by the frontend's info bar)
- right-click menus unbound (frontend handles its own)
- split-pane keys unbound
- `set-clipboard on` (OSC 52 → browser clipboard)

### 8. User processes

Whatever you run inside the tmux session — bash, vim, htop, nuclei, build
scripts. They have no idea anything is unusual; they're just running in a
TTY backed by a PTY backed by tmux.

## Data flow examples

### A keystroke

```
keydown event in xterm
  → xterm.onData(data: string)
    → ws.send(textEncoder.encode(data))            // binary, tag 0x01 + sessionId + payload
      → server: handleBinary → case TAG.STDIN
        → entry.subscribers.has(ws) check
          → entry.pty.write(buf.toString('utf8'))
            → kernel writes into PTY master
              → kernel delivers to PTY slave (tmux client)
                → tmux client forwards to tmux server
                  → tmux server delivers to bash
                    → bash echoes the byte back through the chain
```

End-to-end RTT is ~0.8 ms median through this entire chain (loopback only).

### An upload

```
upload-start (JSON text frame) ──► server.startUpload()
                                   - sanitizeName (no /, \, .., NUL, control bytes, leading dot)
                                   - getSessionCwd via tmux display-message
                                   - O_EXCL open of <name>.uploading
                                   - emit upload-ready { uploadId, path }
client streams FILE_UP_CHUNK (binary, tag 0x03) frames with [idLen][id][seq][bytes]
                                   - decodeFilePayload validates shape
                                   - wsForUpload.get(upload) === ws check (defense)
                                   - appendChunk: seq must == upload.expectedSeq
                                   - bytesReceived += chunk.length, must not exceed declaredSize
                                   - on bytesReceived === declaredSize: fsync, fchmod, rename(.uploading → final)
                                   - emit upload-complete
```

WS disconnect mid-upload → temp file `unlink`'d, no half-written state.

### Reconnect after PWA wake

```
iOS suspends WS  → TCP silently severed
visibilitychange → fired with state="visible"
client.probeConnection()
  → ws.send({type:'ping', t: Date.now()})
  → setTimeout(() => ws.close(4000, 'probe-timeout'), 3000)

if pong arrives < 3 s   → clearTimeout, normal operation continues
if no pong              → ws.close(...) → onclose → scheduleReconnect()
                        → exponential backoff (1s, 2s, ..., 30s cap)
                        → on visible AND tab-active: connect()
                          → re-fire session-list; re-attach every tab in storage; resize
```

Server-side WS-level keepalive (`ws.ping()` every 30s, `terminate()` on missed
pong) catches the same dead-connection from the other direction within ~30–60 s
even without a frontend visibility event.

## Wire format reference

Brief — full spec in [Protocol](./protocol.html) and [PROTOCOL.md](https://github.com/anandsreekumaras/terminalcat/blob/main/PROTOCOL.md).

```
binary frame:  [tag:1] [sidLen:1] [sessionId: sidLen bytes UTF-8] [payload]
                tag = 0x01 STDIN          (client → server)
                      0x02 STDOUT         (server → client)
                      0x03 FILE_UP_CHUNK  (client → server)
                      0x04 FILE_DOWN_CHUNK (server → client)
                sessionId regex: ^[a-zA-Z0-9_-]{1,64}$

control frame: JSON text — discriminated union on `type`
                resize, session-list, session-open/close/kill/rename/cwd,
                tmux-mouse, upload-start, ping
```

File-transfer chunks add an inner header inside the payload:
```
[idLen:1] [transferId: idLen bytes] [seq:4 BE] [bytes...]
```

## Why each layer

| Layer | Could we skip it? | What we'd lose |
|---|---|---|
| Cloudflare Access | Yes (any reverse proxy + auth) | Free SSO + IdP integrations + edge auth |
| cloudflared tunnel | Yes (open a public port) | "no inbound port" property; tunnel survives ISP changes / NAT |
| Loopback bind | No | Defense-in-depth against accidental binding to 0.0.0.0 |
| JWT verify at origin | No | We'd be trusting an unsigned `Cf-Access-Authenticated-User-Email` header |
| node-pty (vs `child_process.spawn`) | No | TUI apps, signals, raw mode, colors all break |
| tmux as the PTY child | No (could attach bash directly) | Persistence — closing the browser would kill bash |
| Multiplexer | Yes (one WS per tab) | One TCP connection per tab from the client; mobile carriers limit concurrent connections; we'd hit it |

## Source code map

| File | What it does |
|---|---|
| `src/server.ts` | HTTP + WS bootstrap, auth gate, multiplexer, control-message dispatch |
| `src/auth.ts` | jose JWKS cache + JWT verification |
| `src/sessions.ts` | tmux subprocess management; spawnPtyForSession; renames |
| `src/protocol.ts` | binary frame encoding/decoding; sessionId validation |
| `src/schema.ts` | zod schemas for every JSON control message |
| `src/upload.ts` | name sanitiser; cwd resolution; chunk reassembly; atomic rename |
| `src/download.ts` | UNIX-socket listener for the `webdl` / `webnotify` shims |
| `src/config.ts` | env loading (with .env support); fail-fast checks |
| `src/log.ts` | pino + daily rotation |
| `public/index.html` | single-file frontend (xterm.js, WS, mobile UX, helper bar, …) |
| `public/sw.js` | pass-through service worker (PWA install gate only) |
| `bin/webdl` | download CLI — writes JSON line to UNIX socket |
| `bin/webnotify` | notification CLI — same socket |
| `bin/terminalcat-open` | `BROWSER=` shim for tools that try to launch a local browser |
| `deploy/terminalcat.service` | origin systemd unit (template) |
| `deploy/cloudflared-terminalcat.service` | tunnel systemd unit (template) |
| `deploy/cloudflared.yml` | tunnel ingress config (template) |
