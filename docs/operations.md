---
title: Operations
layout: default
nav_order: 6
---

# Operations
{: .no_toc }

Day-2 stuff: updating, logs, restarts, verifying, debugging.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Updating

```bash
cd ~/terminalcat
./scripts/update.sh
```

Idempotent. Refuses on a dirty working tree. Sequence: `git pull --ff-only`
→ `pnpm install --frozen-lockfile` → `pnpm build` → `sudo systemctl restart terminalcat`.

Flags: `--no-pull` (rebuild after a manual edit), `--no-restart` (build only).

## Logs

```bash
# tail the origin
sudo journalctl -u terminalcat -f

# tail the tunnel
sudo journalctl -u cloudflared-terminalcat -f

# both at once
sudo journalctl -u terminalcat -u cloudflared-terminalcat -f
```

If `LOG_DIR` is set, daily-rotated pino files also accumulate there. They're
JSON-per-line — pipe through `pino-pretty` for human-readable form, or
`jq` to query:

```bash
sudo tail -F /var/log/terminalcat/terminalcat.log | jq -r '"\(.time) \(.level) \(.msg)"'
```

## Restart / status

```bash
# origin
sudo systemctl status terminalcat
sudo systemctl restart terminalcat
sudo systemctl is-active terminalcat

# tunnel
sudo systemctl status cloudflared-terminalcat
```

## Reliability

### Crash recovery

`Restart=always` + `StartLimitBurst=10/60s` means a crashing terminalcat
gets revived for up to 10 attempts in a 60s window. Beyond that the
service goes into `failed` state — restart faster won't help, something's
wrong (e.g., bad `.env`, port collision, bad code).

```bash
# inspect the failure mode
sudo systemctl status terminalcat
sudo journalctl -u terminalcat --no-pager -n 50
```

### Verifying clean disconnect (no zombies)

After closing a browser tab — especially mid-running-process — these checks
should all be clean:

```bash
# 1. PTY children must be reaped. The only `tmux new -A …` process that
#    should remain is the tmux *server*, which has PPID=1 and stays alive
#    across disconnects on purpose. Anything with a different PPID is an
#    orphan client that didn't exit on SIGHUP — that's a bug, file it.
ps -eo pid,ppid,args | grep "tmux new -A" | grep -v grep

# 2. No <defunct> processes — those would mean we're not waitpid'ing.
ps -eo pid,stat,args | awk '$2 ~ /Z/'

# 3. Sessions persist. Anything you started inside tmux before closing
#    the tab is still alive. That's the property we built around.
tmux list-sessions
```

If you started `sleep 300 &` before closing the tab, it should still be running:

```bash
ps -eo pid,ppid,args | grep "sleep 300" | grep -v grep
```

Open a new tab, and the new WS connection re-attaches the same tmux session
— your running process is right where you left it.

The thing terminalcat deliberately doesn't ship is code-server's behaviour
of killing the inner shell on WS close. With tmux as the PTY child, the
cleanup boundary is the tmux *client* (which we SIGHUP-then-SIGKILL), not
the user's processes inside it.

## Caching

Per-extension `Cache-Control` policy on the static handler:

| Extension | Policy |
|---|---|
| `.html`, `.js` (incl. `sw.js`) | `no-cache, must-revalidate` — always revalidates via ETag, gets 304 when unchanged |
| `.svg`, `.png`, `.ico`, `.woff2`, `.webmanifest` | `public, max-age=86400` — 1 day cache, browser skips network entirely |
| anything else | `no-store` — safe default |

ETag shape: `W/"<size-hex>-<mtimeMs-hex>"`. Cheap (one stat call), changes
when the file changes. After `pnpm build` regenerates `index.html` etc.,
the next refresh sees a fresh 200 because mtime changed → ETag changed.

**No service-worker caching.** The SW is pass-through for PWA install
eligibility only. Avoiding SW caching is deliberate — the project ships
fast and stale-asset bugs after deploy are exactly what we don't want.
See [Architecture](./architecture.html).

## Tunnel health

```bash
cloudflared tunnel info terminalcat
```

Should show 4 connections to varied POPs (e.g. `bom08`, `bom11`, `maa01`,
`maa05`). Zero connections = tunnel is down (will surface as Cloudflare
1033 errors at the public URL).

```bash
# is the actual TCP origin healthy?
ss -ltnp 2>/dev/null | grep 7682
curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:7682/
# expect 401 (auth-gated) — anything else means the origin is misconfigured
```

## Rotating credentials

### Cloudflare Access — session

Sessions cap at the duration you set in the Access app. Force re-auth by
clearing the cookie at `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/logout`
or by reducing the session duration on the Access app.

### cloudflared tunnel credentials

```bash
# CLI-managed tunnel (the cred file pattern this project ships):
cloudflared tunnel route dns --overwrite-dns terminalcat shell.YOUR-DOMAIN
# above forces a DNS recreate; the tunnel UUID stays the same.

# To rotate the secret entirely, delete and recreate:
sudo systemctl stop cloudflared-terminalcat
cloudflared tunnel delete -f terminalcat
cloudflared tunnel create terminalcat
# then update ~/.cloudflared/terminalcat.yml with the new UUID + cred path
cloudflared tunnel route dns terminalcat shell.YOUR-DOMAIN
sudo systemctl restart cloudflared-terminalcat
```

### tmux server-state

Wipe everything (kills all sessions and any running processes inside):

```bash
tmux kill-server
# next browser hit will create fresh sessions
```

## What "looks healthy" looks like

```bash
# units
$ sudo systemctl is-active terminalcat cloudflared-terminalcat
active
active

# port
$ ss -ltn | grep 7682
LISTEN 0  511  127.0.0.1:7682  0.0.0.0:*

# tunnel
$ cloudflared tunnel info terminalcat | tail -2
CONNECTOR ID                          ARCHITECTURE  VERSION   ORIGIN IP        EDGE
abc-…                                 linux_arm64   2026.3.0  150.230.129.231  1xbom08, 1xbom11, 1xmaa01, 1xmaa05

# auth gate
$ curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:7682/
HTTP 401

# public URL
$ curl -sS -o /dev/null -w "HTTP %{http_code}  Loc: %{redirect_url}\n" https://shell.YOUR-DOMAIN/
HTTP 302  Loc: https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/login/...

# no orphans
$ ps -eo pid,stat | awk '$2 ~ /Z/' | wc -l
0
```

## Common ops scenarios

See [Troubleshooting](./troubleshooting.html) for failure modes and how to
fix them.
