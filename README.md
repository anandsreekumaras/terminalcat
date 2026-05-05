# terminalcat

> A self-hosted web terminal that doesn't kill your processes when you close
> the browser. Multi-tab. Mobile-friendly. Cloudflare-Access-gated. Backed
> by `tmux` for session persistence — closing the tab detaches; reopening
> reattaches; nothing inside dies.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/Node-%3E%3D20.0-success)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)

> **Status:** personal project shared in case it's useful. PRs welcome,
> issues read as time permits, no support SLA. See [SECURITY.md](SECURITY.md)
> before deploying to anything you care about.

---

## Why this exists

I wanted a web terminal I could use from a phone during bug-bounty work
without losing scans every time my laptop slept or my train went into a
tunnel. The existing options had problems:

| | this | code-server | gotty / wetty / ttyd |
|---|---|---|---|
| Closes browser → process keeps running | ✅ (tmux owns it) | ❌ (kills bash on disconnect) | ⚠️ no built-in tmux integration |
| Multi-session tabs | ✅ | ❌ (single shell) | ❌ |
| Mobile-friendly (helper bar, sticky modifiers, pinch-zoom font) | ✅ | ⚠️ minimal | ❌ |
| File upload + download (web ↔ box) | ✅ (drag-drop + `webdl` CLI) | ⚠️ via VS Code only | ❌ |
| Cloudflare Access JWT verified at origin | ✅ | ⚠️ via reverse proxy | ⚠️ via reverse proxy |
| PWA-installable (Add to Home Screen) | ✅ | ✅ | ❌ |

If those bullets describe what you want, terminalcat may fit. If you need
multi-user partitioning, IDE features, collaboration, or commercial
support — try something else.

---

## Screenshots

> *SVG mockups hand-built from the actual Tokyo-Night palette terminalcat
> ships with. They render natively in GitHub. Real device screenshots
> can replace these in [docs/screenshots/](docs/screenshots/) anytime —
> see that directory's README for which file goes where.*

**Desktop** — multi-tab, helper bar, info bar, detached chips, transfer card, the works:

![terminalcat desktop UI](docs/screenshots/desktop.svg)

**Mobile (PWA, keyboard up)** — helper bar floats above the keyboard,
helper-bar `🖱` button toggles tmux-mouse mode, `Ctrl` is sticky:

![terminalcat mobile UI](docs/screenshots/mobile.svg)

**Right-click on the terminal** — small Windows-style context menu at the
cursor (long-press on mobile opens an action sheet with the same items):

![terminalcat right-click menu](docs/screenshots/right-click-menu.svg)

## Architecture

```
   browser  ──tls──▶  Cloudflare Access  (SSO + JWT mint)
                            │
                            ▼  signed JWT in Cf-Access-Jwt-Assertion
                    cloudflared tunnel  (QUIC outbound; no inbound port)
                            │
                            ▼  http
                    127.0.0.1:7682   ←—  bind enforced loopback-only
                            │
                    ┌───────┴───────┐
                    │  src/server   │   ws upgrade gate (jose verify aud+iss)
                    │   (Node + ws) │   tagged binary frames + JSON control
                    └───────┬───────┘
                            │
                    ┌───────┴────────┐
                    │  node-pty       │  one PTY child per attached session
                    └───────┬────────┘
                            │
                       tmux server  ←—  source of truth; outlives Node
                            │
                       bash, vim, nuclei, …  (your processes)
```

Each browser tab corresponds to a tmux session. Detaching a tab keeps the
session running; reattaching reconnects to the same processes. Closing the
browser doesn't kill anything inside.

See [PROTOCOL.md](PROTOCOL.md) for the wire format.

---

## Prerequisites

Hard requirements:

- **A Linux box** to host on (tested on Debian 12, Ubuntu 22.04+, Fedora
  39+; aarch64 and x86_64 both work).
- **A Cloudflare account.** Free tier is enough.
- **A domain managed in Cloudflare.** terminalcat is exposed via Cloudflare
  Tunnel + Cloudflare Access — both bind to a hostname under a Cloudflare-
  managed zone. If your domain isn't in CF, you'll need to either add it
  (free) or pick a different reverse-proxy + auth front-door (out of scope
  here).
- **Cloudflare Zero Trust enabled** on the account. Free for up to 50
  users. Sign up at https://one.dash.cloudflare.com/.

The installer brings in everything else — Node 20+, pnpm (via corepack),
tmux, git, cloudflared, build tools — using your distro's package manager.

---

## Quick install

One-liner (works on Debian/Ubuntu/Fedora/RHEL/Arch — installer auto-detects):

```bash
curl -fsSL https://raw.githubusercontent.com/anandsreekumaras/terminalcat/main/scripts/install.sh | bash
```

Or after cloning manually:

```bash
git clone https://github.com/anandsreekumaras/terminalcat.git ~/terminalcat
cd ~/terminalcat && ./scripts/install.sh
```

The installer:

1. Detects your OS / package manager (apt / dnf / yum / pacman).
2. Installs missing prerequisites (Node 20 LTS via NodeSource, pnpm via
   corepack, tmux, git, build-essential / gcc-c++, cloudflared).
3. Clones/updates the repo.
4. Runs `pnpm install` (compiles node-pty from source on aarch64).
5. Prompts interactively for `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`.
   See **Cloudflare setup** below for where to find these.
6. Optionally installs the systemd unit (`Restart=always`, non-root user).
7. Optionally symlinks the `webdl` and `webnotify` CLI shims into
   `/usr/local/bin`.

Idempotent — re-run anytime to update / reconfigure. Override defaults
with `TERMINALCAT_REPO=…` (your fork) or `TERMINALCAT_DIR=…` (custom path).

---

## Cloudflare setup (required)

terminalcat does **not** open a port on the public internet. Traffic
reaches it through a Cloudflare Tunnel, gated by a Cloudflare Access
application. You only need to do this once per terminalcat install.

### 1. Pick a hostname

Decide on the URL you want, e.g. `shell.example.com`. The domain part
(`example.com`) must be a zone in your Cloudflare account.

### 2. Create the tunnel

On the box that's running terminalcat:

```bash
cloudflared login                          # one-time browser SSO
cloudflared tunnel create terminalcat       # writes credentials JSON
cloudflared tunnel route dns terminalcat shell.example.com
```

`cloudflared tunnel create` will print a UUID and a path to a credentials
JSON — paste those into `deploy/cloudflared.yml` (replace the placeholder
`REPLACE-WITH-YOUR-TUNNEL-UUID` strings).

Then run the tunnel:

```bash
# foreground (testing):
cloudflared tunnel --config /home/<user>/terminalcat/deploy/cloudflared.yml run

# or as a systemd service (production — survives reboot):
sudo cloudflared service install
# move/symlink deploy/cloudflared.yml to /etc/cloudflared/config.yml first
```

### 3. Create the Cloudflare Access application

Cloudflare Zero Trust dashboard → **Access** → **Applications** →
**Add an Application** → **Self-hosted**.

| Field | Value |
|---|---|
| Application name | `terminalcat` |
| Application domain | `shell.example.com` |
| Session duration | 24h (or shorter — your call) |

Add a policy:

- **Action:** Allow
- **Selector:** Emails → your email address
  *(Don't use "any email from <my domain>" — old or compromised employees may still hold the address.)*

Save. Open the new app → **Overview** tab → copy:

- **Application Audience (AUD) Tag** — a 64-char hex string.
- Your **team domain** — the part before `.cloudflareaccess.com`. Find it
  top-left of the Zero Trust dashboard, or under Settings → General.

Paste both into `.env`:

```bash
CF_ACCESS_TEAM_DOMAIN=acme
CF_ACCESS_AUD=0000000000000000000000000000000000000000000000000000000000000000
```

The installer prompts for these — you can skip step 3 here and answer
the installer's questions instead.

### 4. Visit the URL

```
https://shell.example.com/
```

You should be redirected to `https://<team>.cloudflareaccess.com/...` for
the SSO login flow. After authenticating, you land back on terminalcat
with the bash prompt.

---

## Mobile install (PWA)

After the URL is reachable, install it as an app on your phone:

- **iOS Safari:** Share → **Add to Home Screen**. Opens fullscreen, no URL bar.
- **Android Chrome:** stay on the page a few seconds → install icon
  appears in the URL bar (or `⋮` menu → **Install app**).

The Add-to-Home-Screen experience uses the included `manifest.webmanifest`
+ `sw.js` (a no-op service worker that exists only to satisfy install
criteria — there is no caching). Standalone display: no browser chrome,
helper bar at bottom above the keyboard, pinch on the terminal area to
adjust font size (10–24 px, persisted in `localStorage`).

---

## Usage notes

- **Tabs**: top bar. `+` creates `tab1`, `tab2`, …. Click to switch.
  Right-click (desktop) / long-press (mobile) → Rename / Detach / Kill.
  Double-click to rename.
- **Right-click in the terminal**: Copy / Paste / Select all / Search /
  Clear screen / Detach.
- **Keyboard shortcuts** (all desktop):
  - `Ctrl+Shift+C` — copy selection
  - `Ctrl+Shift+V` — paste from clipboard
  - `Ctrl+Shift+A` — select all (incl. scrollback)
  - `Ctrl+Shift+F` — search in scrollback
  - Plain `Ctrl+C/A/V` still go to the shell (SIGINT / start-of-line /
    verbatim-insert) — same convention as `gnome-terminal`.
- **Helper bar (mobile)**: Esc / Tab / sticky Ctrl / sticky Alt / arrows /
  `^A` / `^C` / `^D` / upload / snippets / search / mouse-mode toggle.
- **Mouse-mode toggle (🖱 in helper bar)**: ON (default) = scroll wheel
  scrolls tmux's scrollback, mouse selection requires Shift+click+drag.
  OFF = native xterm selection works without Shift, scroll wheel sends
  ↑/↓ keys to bash readline (= command history navigation). Pick the
  trade-off you prefer.
- **File upload**: drag a file onto the terminal area (desktop) or tap
  ⇪ in the helper bar (mobile picker). Lands at the active tab's
  `pane_current_path`. Max 500 MB / 1 concurrent / session.
- **File download**: from inside any tab,
  `webdl /path/to/file` — file streams to your browser as a download.
  Requires the shim symlinked in PATH (the installer offers this).
- **Notifications**: `webnotify "scan finished"` — pings the active
  browser tab; if the page is backgrounded, a real OS notification fires
  (browser permission required, asked on first interaction).
- **Detached sessions**: appear as chips in the bottom bar above the
  helper bar — tap to reattach, × to kill.
- **Active info**: bottom info strip shows `● N devices · ▸ <session> ·
  🗀 <cwd> · ⌂ <your-ip>`.

---

## Development

```bash
git clone https://github.com/anandsreekumaras/terminalcat.git
cd terminalcat
corepack enable && corepack prepare pnpm@latest --activate
pnpm install
cp .env.example .env  # fill in CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD
pnpm dev              # tsx watch on src/server.ts
```

Type-check: `pnpm exec tsc --noEmit`. There's no test suite yet — see
[TODO.md](TODO.md). Manual verification per checkpoint is described in
the source comments and PROTOCOL.md.

### Repo layout

```
src/                  # backend (Node + TypeScript strict)
  server.ts           # http + ws bootstrap, control router, lifecycle
  auth.ts             # jose JWKS cache + jwtVerify(aud, iss)
  config.ts           # .env loader + required-env validator
  log.ts              # pino + optional pino-roll daily rotation
  schema.ts           # zod schemas for every JSON control message
  protocol.ts         # binary frame encode/decode, sessionId regex
  sessions.ts         # tmux: list/kill/rename/spawn, mouse-on, status-off
  upload.ts           # upload state machine + path sanitiser
  download.ts         # UNIX-socket service for webdl + webnotify shims
public/
  index.html          # single-file frontend (xterm.js + addons via CDN)
  manifest.webmanifest, icon.svg, sw.js   # PWA bundle
bin/
  webdl, webnotify    # CLI shims (Node, talk to UNIX socket)
deploy/
  terminalcat.service # systemd unit (non-root, Restart=always)
  cloudflared.yml     # tunnel config sample
scripts/
  install.sh          # interactive installer
PROTOCOL.md           # wire format spec
SECURITY.md           # threat model + reporting
TODO.md               # explicitly out-of-scope items
```

---

## Verifying clean disconnect (no zombies)

After closing a browser tab — especially mid-running-process — these
should hold on the box:

```bash
# 1. Only the tmux SERVER (PPID=1) should remain. Any other tmux client
#    process is an orphan we failed to reap — file an issue if you see one.
ps -eo pid,ppid,args | grep "tmux new -A" | grep -v grep

# 2. No <defunct> children.
ps -eo pid,stat,args | awk '$2 ~ /Z/'

# 3. Sessions persist by design — anything you started inside tmux
#    before closing the tab is still running.
tmux list-sessions
```

The thing terminalcat deliberately doesn't ship is code-server's
behaviour of killing the inner shell on WS close.

---

## Out of scope

See [TODO.md](TODO.md). Notable: multi-user separation (single-tenant by
design), session sharing, theming UI, ZMODEM/trzsz, asciinema recording,
search-across-sessions, real test suite. There is deliberately no
caching service worker — the included `sw.js` is a no-op pass-through
that exists only to satisfy Chrome's PWA install criterion.

---

## Contributing

This is a personal project. PRs are welcome but I make no commitment to
review them on any timeline; bug reports are read.

Before opening a PR:

- Run `pnpm exec tsc --noEmit` — TypeScript strict mode, must pass.
- Match the existing style: comments only at non-obvious points,
  per-checkpoint scope discipline, no `any` without an inline comment.
- Update `PROTOCOL.md` if you touch the wire format. Update `README.md`
  if you change anything user-facing.
- Don't add features just because. The checkpoint plan that produced v2
  was deliberate; new features should justify their cost.

---

## License

[MIT](LICENSE).

## Credits

Built on excellent upstream work:

- [xterm.js](https://xtermjs.org/) — terminal emulator in the browser
- [node-pty](https://github.com/microsoft/node-pty) — fork-pty for Node
- [ws](https://github.com/websockets/ws) — WebSocket server
- [jose](https://github.com/panva/jose) — JWT verification
- [zod](https://zod.dev/) — schema validation
- [pino](https://getpino.io/) — logging
- [tmux](https://github.com/tmux/tmux) — the actual session persistence
- [Cloudflare Tunnel + Access](https://developers.cloudflare.com/cloudflare-one/) — front door
