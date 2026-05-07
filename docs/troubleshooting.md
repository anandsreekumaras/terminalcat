---
title: Troubleshooting
layout: default
nav_order: 10
---

# Troubleshooting
{: .no_toc }

Failure modes I've actually seen, and what they mean.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## "Error 1033 — no active argo tunnels"

Your DNS CNAME for `shell.YOUR-DOMAIN` exists, but the tunnel it points
at has zero active connectors. Almost always: the `cloudflared-terminalcat`
systemd service isn't running.

```bash
sudo systemctl status cloudflared-terminalcat
sudo systemctl restart cloudflared-terminalcat
sudo journalctl -u cloudflared-terminalcat -n 50 --no-pager
```

Check `cloudflared tunnel info terminalcat` — should list 4 connections
to varied POPs. If it lists 0, the tunnel is registered but not running
locally.

## "Error 502 / 503 from Cloudflare, terminalcat down"

Tunnel is up, but the origin behind it isn't.

```bash
ss -ltn | grep 7682              # is the origin listening?
sudo systemctl status terminalcat  # is the origin service active?
sudo journalctl -u terminalcat -n 50 --no-pager
```

If the origin keeps crashing on start, the most common cause is `.env`
issues — `CF_ACCESS_TEAM_DOMAIN` or `CF_ACCESS_AUD` empty. The startup
log is explicit:

```
refusing to start: env var CF_ACCESS_TEAM_DOMAIN is required.
Copy .env.example to .env and fill it in, or set it via systemd.
```

## "Login redirect, then immediately back to login"

Cloudflare Access mints a JWT, browser carries it, but the origin rejects
it. Check the origin log:

```bash
sudo journalctl -u terminalcat -n 50 | grep '\[auth\]'
```

Common reasons:

- **`JWT signature invalid` / `JWT kid not in JWKS`** — `CF_ACCESS_TEAM_DOMAIN` doesn't match the team that minted the JWT. Check that the env var matches the team domain in your Access app.
- **`JWT claim invalid: aud`** — `CF_ACCESS_AUD` doesn't match the AUD of the Access app that protects this hostname. Check Application Audience Tag in the dashboard.
- **`JWT expired`** — clock skew between origin and Cloudflare. `timedatectl status` should show NTP synced. `sudo timedatectl set-ntp true` if not.
- **`JWT missing email claim (service token?)`** — you've configured a service-token policy on the Access app. We only accept user JWTs (with email + sub). Reconfigure the Access policy as user-based.

## "401 unauthorized on every request"

If you see this even after CF Access SSO succeeds, the most likely cause
is an HTTP request that *bypassed* CF Access — e.g., direct curl to
`http://127.0.0.1:7682/`. That's expected: 401 is the correct answer
when there's no `Cf-Connecting-Ip` + `Cf-Access-Jwt-Assertion`.

If you're seeing it through the public hostname after auth, it's one of
the JWT problems above.

## "PWA stuck after wake — typing does nothing"

Should be fixed on current main (server-side keepalive + visibility-driven
probe). If you still see it:

- Check that you're on a recent commit:
  ```bash
  cd ~/terminalcat
  git log --oneline -5
  ```
- After a `git pull`, you must rebuild + restart:
  ```bash
  ./scripts/update.sh
  ```
- The "stuck" state should now resolve in ~3 seconds (visibility probe times out, force-closes, reconnects).

If after that you genuinely see indefinite stuck state, file an issue
with browser version + iOS / Android version + a screenshot of the
console (Safari: Settings → Advanced → Web Inspector, then via Mac).

## "Connection drops every few minutes"

Likely NAT or CGNAT idle timeout if you're on a mobile carrier. The
server-side keepalive (30s) should keep the connection alive. If it's not:

```bash
# is the keepalive timer firing?
sudo journalctl -u terminalcat -n 100 | grep keepalive
```

You should see no log lines normally (the keepalive only logs on
*termination* of dead clients, not every ping). If you see frequent
"keepalive: no pong, terminating dead connection" lines, the path is
genuinely flaky and the keepalive is doing its job — reconnect should
fire on the client.

## "node-pty install failed"

```
gyp: No Xcode or CLT version detected!
# OR
make: command not found
# OR
gcc: command not found
```

You're missing build tools. node-pty has prebuilt binaries for common
Node + arch combos but falls back to compile-from-source.

```bash
# Debian / Ubuntu
sudo apt-get install -y build-essential python3

# Fedora / RHEL
sudo dnf install -y gcc gcc-c++ make python3

# Then re-run pnpm install
pnpm install
```

The terminalcat installer handles this — only an issue if you're doing
a manual install path.

## "Type errors after pnpm install"

```
TS2307: Cannot find module 'zod' or its corresponding type declarations.
```

You probably have an out-of-date `pnpm-lock.yaml` from a previous version,
or you're using a different pnpm than the project pins. Try:

```bash
rm -rf node_modules
pnpm install --frozen-lockfile
pnpm typecheck
```

If `pnpm` complains the lockfile is incompatible, use the version pinned
in `package.json`'s `packageManager` field. corepack handles this:

```bash
corepack enable
```

Then `pnpm install` will use the pinned version.

## "Cloudflared keeps reconnecting / control stream errors"

```
Serve tunnel error error="control stream encountered a failure while serving"
```

Two common causes:

- **Stale token / deleted tunnel**: the tunnel UUID in your config has been
  deleted in the dashboard, or the credentials are stale. Check
  `cloudflared tunnel list` — if the tunnel name isn't there, delete the
  config file and recreate.
- **Multiple cloudflared with the same token**: two services trying to run
  the same tunnel. `ps -eo pid,args | grep cloudflared` — should show one
  per tunnel.

## "Origin keeps restarting"

```bash
sudo systemctl status terminalcat
# Look for: "Service has triggered the StartLimit*"
```

Origin is crashing repeatedly. `StartLimitBurst=10/60s` means after 10
crashes in 60s, systemd gives up. To diagnose:

```bash
sudo journalctl -u terminalcat -n 100 --no-pager
```

Look for the actual stack trace. Most common causes:

- Bad `.env` (env-var validation failing)
- Port 7682 already in use by another process
- node-pty fail to load (missing prebuilt binary on this arch + missing build tools)
- Bad `dist/` after a partial build (`pnpm build` to refresh)

## "WebGL renderer fails"

```
[term <id>] WebGL fallback: <error>
```

Mobile Safari sometimes refuses WebGL contexts. Falls back to canvas
automatically — the warning is informational. If you want to force
canvas (more compatibility, slightly slower scrolling), comment out the
WebGL block in `public/index.html`.

## "Service worker shows 'unregistered' / 'redundant'"

Open browser DevTools → Application → Service Workers. If you see an old
SW from a previous deploy, click **Unregister**, then refresh. Our SW is
pass-through; "redundant" state usually means the new SW is taking over.

## "Upload fails with 'invalid-name'"

The sanitiser rejected the filename. See [Security → Upload sanitiser](./security.html#upload-sanitiser)
for the rules. If the rejection seems wrong (e.g. an emoji-named file), file an issue.

## "Upload fails partway through"

Possible reasons:

- WS disconnected mid-upload (mobile suspend, network blip) — server cleans up the temp file; just retry
- File grew while uploading (rare; declared-size enforcement fail-closes the upload)
- Disk full — server emits `upload-failed` with a real error message

Resumable uploads aren't implemented (yet); see [TODO](https://github.com/anandsreekumaras/terminalcat/blob/main/TODO.md).

## Where to ask

- General usage / config: open a [GitHub Discussion](https://github.com/anandsreekumaras/terminalcat/discussions) (or an issue if you're sure it's a bug)
- Security issues: see [SECURITY.md](https://github.com/anandsreekumaras/terminalcat/blob/main/SECURITY.md), don't file public issues
- Feature requests: open an issue tagged `enhancement`; check [TODO.md](https://github.com/anandsreekumaras/terminalcat/blob/main/TODO.md) first to see if it's been considered
