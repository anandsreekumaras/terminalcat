---
title: Features
layout: default
nav_order: 3
---

# Features
{: .no_toc }

What ships in v2.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Multi-tab sessions

Each browser tab is a separate **tmux** session. The tab bar shows session id
+ short cwd. Click `+` to create a new session, click any tab to switch.
Long-press / right-click to rename, kill, or detach.

- Background-tab activity indicator (a dot lights up when output arrives in an inactive tab)
- Reload restores all tabs from `tmux list-sessions` and reattaches; the last-active tab is centered into view
- One xterm instance per tab, each with its own FitAddon (no shared state)
- Configurable scrollback (default 1000 lines)

## Persistence (the headline)

Closing a tab, closing the browser, restarting the Node server — none of it
kills your processes. They live in tmux; the WS layer is just a viewport.

- **Server-side**: `tmux server` (PID 1) outlives both Node and cloudflared restarts.
- **Tab-side**: when you reload, the frontend asks `session-list`, recreates each tab, and re-subscribes.
- **Reconnect**: WS keepalive + a visibility-driven probe means PWA returns from background land reconnects within ~3 seconds. See [Operations → Reliability](./operations.html#reliability).

The deliberate non-feature: **if a session has no subscribers, the PTY child gets SIGHUP**. Tmux still owns the inner shell, but the lightweight Node-side wrapper is reaped — saves a thread + an FD per dormant tab. Reattach respawns it.

## File transfer

Both directions, end-to-end through the same authed WS.

### Upload (browser → box)

- Drag-and-drop on desktop, file-picker button on mobile
- Lands in the cwd of the active session
- Path-traversal sanitised on the server (rejects `/`, `\`, `..`, NUL, control bytes, leading dot)
- Atomic: writes to `<file>.uploading`, fsyncs, fchmods, renames
- Per-session + per-WS concurrency caps; 500 MB default size cap; declared-size enforcement (overruns fail-closed)
- Progress via `upload-progress` control messages every ~16 chunks
- Disconnect mid-upload → temp file cleaned up

### Download (box → browser)

- `webdl <file>` from inside any tmux session in terminalcat
- The `webdl` shim writes a JSON line to `~/.cloudflared/.../terminalcat.sock` (UNIX domain, mode 0600); server pushes file via tagged binary frames; browser triggers a normal `<a download>` save
- iOS surfaces it via the OS download manager → Files app

Side-channel design (UNIX socket, not escape-sequence parsing) is deliberate — escape parsing is fragile across terminal multiplexers; explicit message channel is unambiguous.

## Mobile-first UI

Designed primarily for the phone, secondarily for the laptop. See [Mobile UX](./mobile.html) for full details. Highlights:

- **Helper bar above the on-screen keyboard** with the keys mobile keyboards lack: `Esc`, `Tab`, `Ctrl`, `Alt`, arrows, `Ctrl+C`, `Ctrl+D`. `Ctrl` and `Alt` are sticky modifiers.
- **Long-press anywhere on the terminal** → action sheet (paste, copy selection, clear, detach). iOS Safari's default long-press menu is suppressed on the terminal area only.
- **Pinch-to-zoom** adjusts xterm font size (clamped 10–24 px), persisted in localStorage.
- **visualViewport API integration**: when the on-screen keyboard appears, the terminal resizes so the prompt stays visible above the keyboard.
- **Disable browser pull-to-refresh** on the terminal area (`overscroll-behavior: contain`).
- **PWA installable** with a web manifest + apple-mobile-web-app meta tags. Add to Home Screen feels like a native app.

## Real-time multi-device

Multiple tabs / devices can subscribe to the same tmux session simultaneously
(it's just normal tmux multi-client). Inputs interleave; outputs broadcast to
every subscriber. The info bar shows a live device count per session. No
collaboration UX (cursors, presence) — it's the raw tmux behaviour.

## Status pills (the bottom info bar)

Replaces tmux's built-in status line with a Tokyo-Night-themed bar:

- `user@host:cwd` (Claude-Code-style, mirrors the shell PS1) — bold green user/host, bold blue cwd
- Device count (how many WSes are subscribed to this session)
- Active session id
- Short cwd (`~/foo` form)
- Your `Cf-Connecting-Ip` (from the verified JWT)

## WS protocol with auto-reconnect

- Tagged binary frames for stdin/stdout (`[tag:1][sidLen:1][sessionId:N][payload]`); JSON text frames for control messages (resize, session-open/close/kill/rename, upload-start, ping, …)
- Disabled `permessage-deflate` (PTY output is already-compact; DEFLATE is wasted CPU)
- Server-side WS keepalive (30s ping + terminate on missed pong)
- Visibility-driven probe on the frontend (instant reconnect detection on PWA wake)
- Exponential backoff on reconnect (1s → 30s cap)
- ETag-based revalidation for static assets — even the `no-cache` HTML benefits from 304s

See [Protocol](./protocol.html) for the full wire spec.

## Cloudflare Access JWT verification

Every HTTP request and every WS upgrade is verified at the origin:

- `jose` against Cloudflare's JWKS endpoint (cached 1h)
- `aud` matches `CF_ACCESS_AUD`
- `iss` matches `https://<TEAM_DOMAIN>.cloudflareaccess.com`
- `exp` / `iat` / `nbf` enforced
- Identity comes only from the verified `email` claim — `Cf-Access-Authenticated-User-Email` is **never trusted** (unsigned, spoofable if request bypasses Cloudflare)
- Defense-in-depth: also requires `Cf-Connecting-Ip` to be present (heuristic that the request came through Cloudflare)

Plus the **CSWSH defense**: optional `ALLOWED_ORIGIN` env var causes WS upgrades whose `Origin` header doesn't match to 403. Permissive on missing Origin (CLI tools / curl unaffected). See [Security](./security.html).

## Renderers

- xterm.js v6
- WebGL renderer (xterm-addon-webgl) preferred; **silent fallback to canvas** on WebGL failure (mobile Safari is finicky)
- xterm-addon-fit + xterm-addon-web-links

## Dev / ops ergonomics

- Compiled-deployment path: `pnpm build` once, systemd runs `node dist/server.js` (saves ~300ms cold start, but +20MB RSS — see [Operations](./operations.html))
- `scripts/update.sh` — `git pull && pnpm build && systemctl restart` in one idempotent script
- Structured pino logs with daily rotation
- Per-WS connection summary log line at close (bytesUp/bytesDown/durationMs/sessionsOpened)
- `webnotify` shim — pushes a notification from inside any session to the active browser tab
- `discord-notify` shim — direct HTTPS POST to a Discord webhook for "task done while I was away" pings (works regardless of whether a browser tab is open). See [Notifications](./notifications.html)

## What's deliberately out of scope

See [TODO.md](https://github.com/anandsreekumaras/terminalcat/blob/main/TODO.md):

- Multi-user / multi-tenant
- Session sharing UI (collaboration cursors etc.)
- Theming UI (dark theme is hardcoded in `public/index.html` — editable, not configurable in-app)
- ZMODEM / trzsz compatibility
- Asciinema-style session recording
- Cross-session scrollback search
- Service-worker offline caching
- Custom font upload
- Test suite beyond manual smoke tests

These are deferred deliberately, not forgotten.
