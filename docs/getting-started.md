---
layout: default
title: Getting started
description: Install terminalcat on your Linux box, wire up Cloudflare Tunnel + Access, and load it in a browser.
---

[← Home](./index.html)

# Getting started

## Prerequisites

- A Linux box (tested on Debian 12, Ubuntu 22.04+, Fedora 39+; aarch64 and x86_64 both work)
- A Cloudflare account with a domain in it (free tier works)
- Cloudflare Zero Trust enabled on the account (free for up to 50 users)

The installer brings in everything else — Node 20+, pnpm via corepack, tmux,
git, build-essential, cloudflared.

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
`REPLACE-WITH-YOUR-TUNNEL-UUID` with the UUID printed above.

### 2. Run the tunnel as a systemd service

```bash
sudo cp deploy/cloudflared-terminalcat.service /etc/systemd/system/
sudo sed -i "s|^User=ubuntu|User=$USER|;s|^Group=ubuntu|Group=$(id -gn)|;s|/home/ubuntu/.cloudflared|$HOME/.cloudflared|g" \
  /etc/systemd/system/cloudflared-terminalcat.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-terminalcat.service
```

⚠️ **Don't use `sudo cloudflared service install`** — that's the dashboard-token
flow and will collide with any other tunnel you have on the box.

### 3. Create the Cloudflare Access application

Cloudflare Zero Trust dashboard → Access → Applications → Add → Self-hosted:

| Field | Value |
|---|---|
| Application name | `terminalcat` |
| Application domain | `shell.YOUR-DOMAIN` |
| Session duration | 24h (or shorter) |

Add a policy:

- **Action:** Allow
- **Selector:** Emails → your email address (NOT "any email from `<my domain>`" — old or compromised employees may still hold the address)

Save. Open the new app → Overview tab → copy:

- **Application Audience (AUD) Tag** — 64-char hex string
- **Team domain** — the part before `.cloudflareaccess.com`. Find it top-left of Zero Trust dashboard, or under Settings → General

Paste both into `.env`:

```bash
CF_ACCESS_TEAM_DOMAIN=acme
CF_ACCESS_AUD=0000000000000000000000000000000000000000000000000000000000000000
ALLOWED_ORIGIN=https://shell.YOUR-DOMAIN
```

`ALLOWED_ORIGIN` is optional but recommended — server-side CSWSH defense.

### 4. Visit

```
https://shell.YOUR-DOMAIN/
```

You should be redirected to `https://<team>.cloudflareaccess.com/` for the
SSO flow. After authenticating, you land back on terminalcat.

## Updating

```bash
cd ~/terminalcat
./scripts/update.sh
```

Pulls main, rebuilds, restarts the systemd service.

## More

- [Source + README](https://github.com/anandsreekumaras/terminalcat) — full README with screenshots, mobile install, "Add to Home Screen", etc.
- [Wire protocol](https://github.com/anandsreekumaras/terminalcat/blob/main/PROTOCOL.md)
- [Security](https://github.com/anandsreekumaras/terminalcat/blob/main/SECURITY.md)
- [Contributing](https://github.com/anandsreekumaras/terminalcat/blob/main/CONTRIBUTING.md)
- [TODO (out-of-scope items)](https://github.com/anandsreekumaras/terminalcat/blob/main/TODO.md)
