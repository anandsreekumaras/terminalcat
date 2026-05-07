---
title: Configuration
layout: default
nav_order: 5
---

# Configuration
{: .no_toc }

Every knob, ranked by likelihood of caring.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Environment variables

Set in `.env` (gitignored), or via systemd `Environment=` / `EnvironmentFile=`.
The installer prompts for the required ones.

### Required

| Variable | What | Where to find |
|---|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | The part before `.cloudflareaccess.com` (e.g. `acme`) | CF Zero Trust → Settings → General → Team domain |
| `CF_ACCESS_AUD` | 64-char hex Application Audience tag of your Access app | CF Zero Trust → Access → Applications → your app → Overview |

Server fails to start (with a clear error) if either is missing.

### Recommended

| Variable | What |
|---|---|
| `ALLOWED_ORIGIN` | Canonical URL (e.g. `https://shell.example.com`). When set, WS upgrades whose `Origin` header doesn't match get a 403. Permissive on missing Origin (CLI tools / curl unaffected). Recommended in production. |

### Optional

| Variable | Default | What |
|---|---|---|
| `LOG_LEVEL` | `info` | pino level: `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `LOG_DIR` | unset | If set, logs go to a daily-rotating file under this dir (in addition to stderr) |
| `OUTPUT_BATCH_MS` | `0` | Coalesce stdout chunks for N ms before flushing one combined WS frame. Helps redraw-spam workloads (htop, animations) at the cost of N ms of added latency. Off (default) keeps the headline keystroke RTT lowest. Range `1..100`. |

### Hardcoded — not env-configurable

Deliberately. The bind address must stay loopback-only; making it tunable
is just an opportunity to misconfigure into a public listener.

| Constant | Value | Why hardcoded |
|---|---|---|
| `HOST` | `127.0.0.1` | Refuses to start if anything else; defense-in-depth |
| `PORT` | `7682` | Pick another and edit `src/server.ts` if you need to; rare |

## systemd units

Two units live in `deploy/`. `scripts/install.sh` does the User= / paths
substitution automatically.

### `deploy/terminalcat.service` — the origin

`Type=simple`, runs as your unprivileged user, `Restart=always`, sandbox
flags (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`,
`ReadWritePaths=$INSTALL_DIR /tmp`), `StartLimitBurst=10/60s`, memory cap
1 GB, `OOMScoreAdjust=-100` so cloudflared and tmux die before us under
memory pressure.

Two ExecStart options:

```ini
# default in the template — runs source via tsx (slower cold start, no build step)
ExecStart=/home/<user>/terminalcat/node_modules/.bin/tsx src/server.ts

# alternative — runs compiled JS (~300ms faster cold start, +20MB RSS)
ExecStart=/usr/bin/node /home/<user>/terminalcat/dist/server.js
```

Switch via a drop-in (recommended) or by editing the unit:

```bash
sudo systemctl edit terminalcat
# (paste:)
[Service]
ExecStart=
ExecStart=/usr/bin/node /home/<user>/terminalcat/dist/server.js
```

After switching, `pnpm build` whenever the source changes — `scripts/update.sh` handles this.

### `deploy/cloudflared-terminalcat.service` — the tunnel

`Type=notify`, runs as the same unprivileged user, `OOMScoreAdjust=-500`
(killing the tunnel cuts off all access). Reads ingress config from
`~/.cloudflared/terminalcat.yml`.

## cloudflared.yml

Sample in `deploy/cloudflared.yml`. The real one lives at
`~/.cloudflared/terminalcat.yml`:

```yaml
tunnel: <YOUR-TUNNEL-UUID>
credentials-file: /home/<user>/.cloudflared/<YOUR-TUNNEL-UUID>.json

ingress:
  - hostname: shell.YOUR-DOMAIN
    service: http://127.0.0.1:7682
    originRequest:
      noTLSVerify: false
      connectTimeout: 10s
      tcpKeepAlive: 30s
      keepAliveTimeout: 5m
      keepAliveConnections: 8

  - service: http_status:404
```

The catch-all 404 entry is required by cloudflared (last entry must be a
service-only rule).

## File paths

| Path | Owner | Purpose |
|---|---|---|
| `~/terminalcat/` | you | source checkout (override via `TERMINALCAT_DIR=`) |
| `~/terminalcat/.env` | you, mode 0600 | env vars (gitignored) |
| `~/terminalcat/dist/` | you | compiled JS output (gitignored) |
| `~/.cloudflared/cert.pem` | you | one-time CF login credential |
| `~/.cloudflared/<tunnel-uuid>.json` | you, mode 0400 | tunnel credentials |
| `~/.cloudflared/terminalcat.yml` | you | per-machine tunnel ingress config |
| `/etc/systemd/system/terminalcat.service` | root | origin unit |
| `/etc/systemd/system/cloudflared-terminalcat.service` | root | tunnel unit |
| `/run/user/<uid>/terminalcat-open.sock` | you, mode 0600 | UNIX socket for `webdl` / `webnotify` shims |
| `/var/log/terminalcat/` | you (if `LOG_DIR` set) | daily-rotated pino logs |

## Scrollback / per-tab memory

Configurable in `public/index.html` (look for `scrollback:` in the
`new Terminal({...})` options). Default 1000 lines per tab.

Cost: scrollback × N tabs lives in browser memory. 1000 lines × 200 chars
× 4 (xterm.js overhead) × N tabs ≈ ~1 MB per tab. Mostly negligible
unless you're on a phone with 50 tabs open.

## Tmux ergonomics

`src/sessions.ts` configures the tmux server on first attach:

- mouse mode on (drag to select, click cancels copy-mode)
- status bar disabled (the frontend's info bar replaces it)
- right-click pane menus unbound
- `set-clipboard on` (OSC 52 — copy-from-tmux lands in your browser clipboard)
- split-pane keys unbound

If you want different tmux config, edit `src/sessions.ts` — those calls run
once per server-startup. Or just use `~/.tmux.conf`; tmux applies it on session creation, after our config calls (so user config wins).
