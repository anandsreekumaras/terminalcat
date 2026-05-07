---
title: Getting started
layout: default
nav_order: 2
---

# Getting started
{: .no_toc }

End-to-end install from a fresh Linux box to a working SSO-gated terminal.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>
  Table of contents
</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Prerequisites

| | |
|---|---|
| OS | Linux (tested on Debian 12, Ubuntu 22.04+, Fedora 39+; aarch64 and x86_64) |
| Account | Cloudflare account with a domain in it (free tier is enough) |
| Zero Trust | Cloudflare Zero Trust enabled (free for up to 50 users) |

The installer handles everything else — Node 20+, pnpm via corepack, tmux,
git, build-essential / gcc-c++, cloudflared.

## One-liner install

```bash
curl -fsSL https://raw.githubusercontent.com/anandsreekumaras/terminalcat/main/scripts/install.sh | bash
```

The installer:

1. Detects your distro / package manager.
2. Installs missing prerequisites.
3. Clones the repo to `~/terminalcat` (override with `TERMINALCAT_DIR=…`).
4. Runs `pnpm install`.
5. Prompts for `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ALLOWED_ORIGIN`.
6. Optionally installs the systemd unit (`Restart=always`, runs as your user).
7. Optionally symlinks the `webdl` and `webnotify` shims into `/usr/local/bin`.

Idempotent. Safe to re-run for upgrades.

Override knobs via env: `TERMINALCAT_REPO=<your fork>` · `TERMINALCAT_DIR=<custom path>` · `ASSUME_YES=1` (auto-accept all prompts).

## Cloudflare setup

terminalcat doesn't open a public port. Traffic reaches it through a
Cloudflare Tunnel, gated by a Cloudflare Access app. One-time setup:

### 1. Create the tunnel

```bash
cloudflared login                                # one-time browser SSO
cloudflared tunnel create terminalcat            # writes credentials JSON
cloudflared tunnel route dns terminalcat shell.YOUR-DOMAIN
```

`cloudflared tunnel create` prints a UUID + a path to the credentials JSON.
Copy `deploy/cloudflared.yml` to `~/.cloudflared/terminalcat.yml` and replace
`REPLACE-WITH-YOUR-TUNNEL-UUID` (both lines) with the UUID printed above.

### 2. Run the tunnel as a systemd service

```bash
sudo cp deploy/cloudflared-terminalcat.service /etc/systemd/system/
sudo sed -i "s|^User=ubuntu|User=$USER|;s|^Group=ubuntu|Group=$(id -gn)|;s|/home/ubuntu/.cloudflared|$HOME/.cloudflared|g" \
  /etc/systemd/system/cloudflared-terminalcat.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-terminalcat.service
```

⚠️ **Do NOT use `sudo cloudflared service install`** — that's the dashboard-token
flow and will collide with any other tunnel you have on the box. The dedicated
unit above sits cleanly alongside.

### 3. Create the Cloudflare Access application

Cloudflare Zero Trust dashboard → **Access** → **Applications** → **Add an Application** → **Self-hosted**:

| Field | Value |
|---|---|
| Application name | `terminalcat` |
| Application domain | `shell.YOUR-DOMAIN` |
| Session duration | 24h (or shorter — your call) |

Add a policy:

- **Action:** Allow
- **Selector:** Emails → your email address (NOT "any email from `<my domain>`" — old or compromised employees may still hold the address)

Save. Open the new app → **Overview** tab → copy:

- **Application Audience (AUD) Tag** — 64-char hex string
- **Team domain** — the part before `.cloudflareaccess.com`. Find it top-left of Zero Trust dashboard, or under Settings → General

Paste them into `.env` (the installer will have prompted for these too):

```bash
CF_ACCESS_TEAM_DOMAIN=acme
CF_ACCESS_AUD=0000000000000000000000000000000000000000000000000000000000000000
ALLOWED_ORIGIN=https://shell.YOUR-DOMAIN
```

`ALLOWED_ORIGIN` enables the [server-side CSWSH defense](./security.html#cswsh-defense). Recommended for production.

### 4. Visit

```
https://shell.YOUR-DOMAIN/
```

You should be redirected to `https://<team>.cloudflareaccess.com/` for the
SSO flow. After authenticating, you land back on terminalcat with bash.

## Updating

```bash
cd ~/terminalcat
./scripts/update.sh
```

Pulls main, rebuilds (the systemd unit runs the compiled `dist/server.js`),
restarts the service. Idempotent. Refuses to run on a dirty working tree
unless you pass `--no-pull`.

## Mobile install ("Add to Home Screen")

Once the URL works in mobile Safari / Chrome, see [Mobile UX](./mobile.html)
for installing it as a real PWA — full-screen, helper bar above the keyboard,
launches like a native app.
