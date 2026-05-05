# Security Policy

## Threat model

terminalcat is **single-tenant** by design. The trust boundary is:

- **Cloudflare Access** — every request is gated at the edge by a CF Access
  application. The origin verifies the resulting JWT (`jose`, signed against
  CF's JWKS, `aud` checked) on every HTTP and WebSocket upgrade.
- **127.0.0.1 bind** — the origin server refuses to bind to anything but
  loopback. Combined with `cloudflared`, no inbound port is open to the
  internet.
- **No multi-user** — anyone who passes the CF Access policy gets full
  shell access on the box, as the user who runs the service. There is no
  per-user partitioning of tmux sessions.

If your threat model assumes multiple users with different privileges
sharing one terminalcat instance, **don't use this**.

## Reporting a vulnerability

If you find a security issue, please **don't open a public GitHub issue**.

Email: open an issue marked private via GitHub's "Report a vulnerability"
button on the Security tab, or email the address listed on my GitHub
profile.

I'll respond as time permits. This is a personal project, not a commercial
product — there is no SLA, but I will read everything and patch what
matters.

When reporting, please include:

- terminalcat version (commit SHA from `git log -1`)
- Node version (`node --version`)
- Reproduction steps
- Whether the issue requires already being authenticated through CF Access

## Out of scope

These are *known* and *intentional*:

- **No multi-user separation.** A single CF Access policy can have multiple
  allowed emails; all of them share one tmux server's sessions.
- **No file-transfer integrity hashing.** Uploads/downloads reassemble by
  byte length only. Hash anything sensitive yourself.
- **Cf-Connecting-Ip presence check is unsigned.** It's a heuristic that the
  request came through Cloudflare; the real defense is the JWT signature.
- **The shim UNIX socket** (`webdl`/`webnotify`) is permission `0600` on
  the filesystem, so anyone with shell access to the running user can use
  it. That matches the trust boundary of the rest of the project.
- **No service-worker caching.** Deliberately so — `sw.js` exists only to
  satisfy the PWA install criterion. Don't add caching to it without
  thinking through CF Access cookie expiry vs cached responses.

## Hardening checklist (for self-hosters)

If you deploy this somewhere meaningful:

- [ ] Run as a non-root user. The systemd unit ships configured this way.
- [ ] Set `LOG_DIR` so failed-auth attempts are persisted.
- [ ] Use a Cloudflare Access policy with at least 2FA on your IdP.
- [ ] Set Access **session duration** short (1–24h). Default in
      `deploy/cloudflared.yml` is 24h.
- [ ] Limit the Access policy to specific emails — not "any email from
      your domain", which a fired ex-employee may still hold.
- [ ] Audit `tmux list-sessions` periodically — tmux outlives terminalcat
      restarts; old sessions accumulate.
- [ ] Subscribe to upstream advisories: `node-pty`, `ws`, `jose`,
      `xterm.js`, `cloudflared`.
