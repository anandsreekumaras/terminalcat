---
title: Security
layout: default
nav_order: 9
---

# Security
{: .no_toc }

Threat model, defense layers, what we don't claim.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Threat model

terminalcat is **single-tenant by design**: one Linux user, one Cloudflare
Access policy, one shell. The threat model assumes:

- The owner has full shell access to the box (and that's the *expected* outcome of a successful login)
- The owner trusts their browser, their Cloudflare account, and their IdP
- All other users on the internet are potentially hostile and must be blocked

We are **not** trying to defend against:

- Other local users on the same box (out of scope; you're presumably the only user)
- An attacker who has already compromised your Cloudflare account, IdP, or the box itself
- Side-channel attacks against tmux or your browser
- Resource exhaustion from a logged-in legitimate user (you can DoS yourself; we don't try to stop you)

If your threat model is meaningfully different (multi-tenant, hostile-user
on the box, regulated environment), this isn't the right tool.

## Defense layers

Five layers gate the path from internet to bash, intentionally redundant:

### 1. Loopback bind

`HOST = '127.0.0.1'` is hardcoded and **checked at startup** — the server
refuses to start if anything else, even via env. Nothing reaches the
origin's TCP socket from off-box, ever.

### 2. cloudflared QUIC tunnel

Outbound-only persistent tunnel. There is no inbound public port on your
VPS. The CF tunnel is the *only* path inbound, and it lives under a
hostname you control on your CF account.

### 3. Cloudflare Access

Edge-side SSO + JWT mint. CF Access verifies your IdP login (email link,
SAML, OIDC, GitHub, whatever you've configured), sets a session cookie,
and from that point onward injects an RS256-signed JWT into every request
flowing through the tunnel. Configure session length to taste (24h is
the project default; shorter is fine).

### 4. Origin-side JWT verification

Every HTTP request and every WS upgrade is verified by `jose`:

- Signature checked against CF's JWKS endpoint for your team domain (cached 1h)
- `aud` claim matches `CF_ACCESS_AUD` env var
- `iss` claim matches `https://<CF_ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`
- `exp` / `iat` / `nbf` enforced
- `email` and `sub` must be present (rejects M2M service-token JWTs)

User identity comes only from the verified `email` claim. The unsigned
`Cf-Access-Authenticated-User-Email` header is **never** trusted — it's
spoofable if the request bypasses Cloudflare somehow.

### 5. Cf-Connecting-Ip presence (defense-in-depth)

Origin requires the `Cf-Connecting-Ip` header to be present. It's a heuristic
that the request actually came through Cloudflare, not via some other path
that bypassed CF Access. Header is unsigned (so an attacker bypassing CF
could forge it), but combined with the loopback bind there's no plausible
path that has the header but skips JWT.

### CSWSH defense (optional)

If `ALLOWED_ORIGIN` is set, WS upgrades whose `Origin` header is present
and doesn't match get a 403. CF Access' default `SameSite=Lax` cookie
already blocks the obvious browser CSWSH path; this hardens the
`SameSite=None` edge case.

Permissive on missing Origin: CLI tools that don't send Origin still work
(they're gated by JWT instead).

## Per-request request-time invariants

| Check | Failure mode |
|---|---|
| Method is GET / HEAD (HTTP only) | 405 + `Allow: GET, HEAD` |
| `Cf-Connecting-Ip` header present | 401 + log line |
| `Cf-Access-Jwt-Assertion` header present | 401 |
| JWT signature valid | 401 |
| JWT issuer + aud + exp valid | 401 |
| JWT carries `email` + `sub` | 401 |
| (WS only, if configured) `Origin` matches `ALLOWED_ORIGIN` | 403 + `socket.destroy()` |
| (Static handler) Path doesn't escape `public/` | 403 — sandbox via `path.resolve` + `startsWith` |

Auth runs **before** the static handler, so an unauthenticated path-traversal
attempt gets 401 before the sandbox even sees the path. The sandbox is a
second layer; the auth gate is the first.

## Specific hardening choices

### Origin file system surface

The systemd unit runs as your unprivileged user, with:
- `NoNewPrivileges=yes`
- `ProtectSystem=strict`
- `ProtectHome=read-only`
- `ReadWritePaths=$INSTALL_DIR /tmp`
- `MemoryMax=1G`

`ProtectHome=read-only` blocks writes outside `ReadWritePaths`; reads still
go through. Under our threat model the owner = the shell = the file owner,
so this isn't a meaningful boundary, but it does close off a class of
"the Node process exfiltrates / corrupts files outside its tree" bugs
even when there's no auth-gate-bypass.

### Upload sanitiser

`src/upload.ts:sanitizeName` rejects:

- length 0 or > 255
- NUL byte
- `/`, `\` (path separators)
- C0 (`< 0x20`) and DEL (`0x7F`) control bytes
- `.` and `..` reserved names
- Leading dot (after trimming leading whitespace, so `" .ssh-evil"` is rejected too)

After name sanitising, defense-in-depth: the resolved final path must
`startsWith(cwd + sep)`. So even if the sanitiser misses a hole, the
write can't escape the session's cwd.

Atomic finalize: write to `<name>.uploading`, fsync, fchmod, rename. If the
WS dies mid-upload, the temp file is unlinked.

Per-session and per-WS concurrency caps. Declared size is enforced (overruns
fail-closed; underruns + disconnect cleanup the temp file).

### Download side-channel

`webdl <file>` writes a JSON line to a UNIX socket (mode 0600, in
`$XDG_RUNTIME_DIR/terminalcat-open.sock` or `/tmp/terminalcat-<uid>.sock`).
**Not** terminal-escape parsing — that's fragile across multiplexers and a
real CVE class.

The socket lives in your runtime dir / `/tmp` with 0600 permissions. Other
local users on the box can't write to it. Single-tenant assumption applies.

The shim identifies the session via `$TMUX` env var (which tmux itself sets
inside any tmux session). If `$TMUX` is unset, the shim refuses with a
clear error.

### Logging

Structured pino logs with daily rotation when `LOG_DIR` is set.
Per-WS-connection summary logged at close: `bytesUp`, `bytesDown`,
`durationMs`, `sessionsOpened`, IP, email. No request bodies, no header
values, no secrets — only metadata.

Auth failures log `[auth] http 401 ip=… url=… reason=…` with the raw
reason from `jose` (e.g. `JWT expired`, `JWT signature invalid`). The
reason is logged server-side only — clients always get a generic
`unauthorized\n`.

## What we don't try to do

- **Multi-user isolation**: there is no such thing. Anyone past the auth gate gets shell as the service user.
- **Encrypted-at-rest persistence**: tmux sessions live in normal RAM on the box; protect the box.
- **CSP / Subresource Integrity for the CDN-loaded xterm.js**: would need a build pipeline. Acceptable trade-off for v2; jsDelivr is well-maintained, the load is over HTTPS, and the SW doesn't intercept it.
- **Audit logging beyond per-WS metadata**: no command-level recording (asciinema is in `TODO.md`).
- **Rate limiting / quotas**: not implemented.

## Reporting a vulnerability

See [SECURITY.md](https://github.com/anandsreekumaras/terminalcat/blob/main/SECURITY.md) in the repo. **Don't open public issues for security bugs** — disclose privately first.
