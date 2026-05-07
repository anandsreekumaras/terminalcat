---
layout: default
title: terminalcat
description: A self-hosted web terminal — multi-session, mobile-friendly, Cloudflare-Access-gated. Backed by tmux for session persistence; closing the browser doesn't kill anything.
---

A web terminal you can run on your own box. Closing the browser doesn't kill
your processes. Use it from a phone during travel; resume from the laptop
when you land. Auth-gated by Cloudflare Access at the edge — no public ports.

[Get started](./getting-started.html){: .btn .btn-primary }
[Source on GitHub](https://github.com/anandsreekumaras/terminalcat){: .btn }
[Protocol spec](https://github.com/anandsreekumaras/terminalcat/blob/main/PROTOCOL.md){: .btn }
[Security](https://github.com/anandsreekumaras/terminalcat/blob/main/SECURITY.md){: .btn }

---

## Why this exists

Existing options had problems for the workflow I actually wanted (long-running
scans + drafts that survive a closed laptop):

|  | terminalcat | code-server | gotty / wetty / ttyd |
|---|---|---|---|
| Closing browser → process keeps running | ✅ (tmux owns it) | ❌ (kills bash on disconnect) | ⚠️ no built-in tmux integration |
| Multi-session tabs | ✅ | ❌ (single shell) | ❌ |
| Mobile-friendly (helper bar, sticky modifiers, pinch-zoom font) | ✅ | ⚠️ minimal | ❌ |
| File upload + download (web ↔ box) | ✅ (drag-drop + `webdl` CLI) | ⚠️ via VS Code only | ❌ |
| Cloudflare Access JWT verified at origin | ✅ | ⚠️ via reverse proxy | ⚠️ via reverse proxy |
| PWA-installable (Add to Home Screen) | ✅ | ✅ | ❌ |

If you need IDE features, multi-user partitioning, collaboration, or commercial
support — try something else. Single-tenant by design.

---

## How it fits together

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

Each browser tab corresponds to a tmux session. Detaching keeps the session
running; reattaching reconnects to the same processes. Closing the browser
doesn't kill anything inside.

---

## Numbers

Reference build (Node 20.20.2, aarch64 Debian 12, single loopback origin
behind Cloudflare Access):

| | |
|---|---|
| Cold start (`systemctl start` → port listening) | ~580 ms |
| WS connect → first server message | 2 ms warm, ~14 ms cold |
| Keystroke round-trip (stdin → bash echo, through PTY+tmux+bash) | **median 0.8 ms · p95 1.1 ms** |
| Stdout throughput (TTY+tmux limited, not Node) | ~1.2 MB/s |
| Resize control → PTY reflects new size | median 2.9 ms |
| Idle RSS / threads / FDs | 53 MB / 11 / 25 |
| Survived in-house WS fuzz | ~100 hostile frames, no crash |

---

## Status

Personal project shared in case it's useful. PRs welcome, issues read as
time permits, [no support SLA](https://github.com/anandsreekumaras/terminalcat/blob/main/README.md). See [Security](https://github.com/anandsreekumaras/terminalcat/blob/main/SECURITY.md)
before deploying to anything you care about.
