# TODO — out of scope for v2

Tracked here so they don't sneak into v2 PRs. Reconsider after v2 ships.

- **Multi-user.** Different Cloudflare-Access emails getting different session sets
  (currently single-tenant — the JWT `email` is recorded but every user sees the same
  tmux sessions).
- **Session sharing / collaboration.** Multiple browsers viewing/typing the same
  session. tmux already supports this natively, but the UI doesn't surface it.
- **Theming UI.** Hardcoded dark theme is editable in `public/index.html`. No in-app
  theme switcher.
- **ZMODEM / trzsz compatibility.** File transfer via terminal escape sequences. We
  do uploads/downloads through a side-channel instead (C11/C12) — this is parsing
  ANSI escapes from the data stream and is fragile.
- **Asciinema-style recording.** Save a session as a replayable `.cast` file.
- **Search across scrollback.** xterm has built-in search via `addon-search`, but
  searching across multiple sessions/windows isn't there.
- **Tests beyond manual smoke.** Real test suite (vitest, playwright for the
  frontend) is deferred to post-v2.
- **Service worker / offline support.** Actively avoided in v1 — caches stale
  assets and confuses debugging. Reconsider only if there's a real reason.
- **Custom font upload.** Bring-your-own webfont. Today the font stack is
  hardcoded to system monospaces.
- **Real screen-recorded demo GIF.** `docs/screenshots/demo.svg` is currently
  a hand-authored SMIL animation (no actual session captured). Re-record with
  [`vhs`](https://github.com/charmbracelet/vhs) once there's a stable
  desktop+mobile env to drive it from. Shape: ~10s loop, hand-typed `nuclei`
  scan + tab-swap + `webdl` download. Output goes to
  `docs/screenshots/demo.gif`; swap the README + `docs/index.md` references.
