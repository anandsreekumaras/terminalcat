---
title: Mobile UX
layout: default
nav_order: 7
---

# Mobile UX
{: .no_toc }

The bits that make a phone-as-primary-shell tolerable.
{: .fs-6 .fw-300 }

<details open markdown="block">
<summary>Table of contents</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

---

## Add to Home Screen

### iOS Safari

1. Open `https://shell.YOUR-DOMAIN/` in Safari (not Chrome — iOS PWA install only works from Safari).
2. Tap the **Share** icon (square + up-arrow).
3. **Add to Home Screen**.
4. Confirm. The app's icon appears on your home screen.
5. Tap it. Launches in standalone mode (no browser chrome).

### Android Chrome

1. Open the URL in Chrome.
2. Three-dot menu → **Install app** (or **Add to Home Screen**).
3. The icon goes to your launcher; tap to open.

The PWA serves under the manifest's `start_url` (`.`) and `display: standalone`,
so it loads full-screen.

## The helper bar

A row of pills above the on-screen keyboard with the keys mobile keyboards
don't surface:

| Key | What |
|---|---|
| `Esc` | The single most-needed key on a mobile shell |
| `Tab` | Same |
| `Ctrl` | Sticky modifier — see below |
| `Alt` | Sticky modifier |
| `↑ ↓ ← →` | Arrow keys |
| `Ctrl+C` | Convenience combo (no need to chord with the sticky `Ctrl`) |
| `Ctrl+D` | Convenience combo (logout / EOF) |
| `🖱` | Toggle tmux mouse mode (drag-select vs scroll) |
| `📋` | Paste from system clipboard |
| `📥` | File upload picker |

### Sticky modifiers

Tap `Ctrl` once → it lights up → next key tap is modified by Ctrl, then
the modifier auto-releases. So **`Ctrl` then `R`** = `Ctrl+R`.

Tapping `Ctrl` twice latches it on (caps-lock-style). Tap a third time
to release. Useful for chains like `Ctrl+R … Ctrl+Z … Ctrl+C`.

Same behaviour for `Alt`.

## Pinch-to-zoom

Two-finger pinch on the terminal area adjusts the xterm font size, NOT the
browser zoom. Clamped between 10 px and 24 px. Persists in localStorage.

The browser-zoom path is suppressed via CSS (`touch-action: pan-y` / no
`pinch-zoom` for the terminal element).

## Long-press → action sheet

Long-press anywhere on the terminal area opens a small bottom sheet with:

- **Paste** — pastes from system clipboard, wrapped in bracketed-paste markers so multi-line clipboards don't execute mid-paste
- **Copy selection** — if there's an xterm selection, copy to clipboard
- **Clear** — clears the terminal viewport (sends `clear`-equivalent escape)
- **Detach** — closes the WS for this session (tmux session keeps running)
- **Kill session** — destroys the tmux session (with confirm)

iOS Safari's default long-press menu is suppressed on the terminal area
specifically (CSS `-webkit-touch-callout: none` + `webkit-user-select: none`
on the term container). Long-press elsewhere on the page (info bar, tabs)
works normally.

## Visual viewport handling

When the on-screen keyboard appears, iOS shrinks the visual viewport to
the area above the keyboard. terminalcat listens to `window.visualViewport`
events and resizes xterm so the prompt stays just above the keyboard
instead of getting pushed off-screen.

This means typing on iOS Safari Just Works — you never lose track of
where the cursor is.

## Pull-to-refresh suppression

The terminal area has `overscroll-behavior: contain` so a downward swipe
doesn't trigger the browser's pull-to-refresh — that would otherwise
disconnect the WS every time you swiped.

The rest of the page (info bar, tabs) keeps default overscroll behaviour
in case you actually want to refresh.

## Connectivity on mobile

iOS PWAs in standalone mode get aggressive backgrounding — the WS often
silently dies when the screen locks or you switch apps. terminalcat
handles this via:

- **Server-side WS keepalive** (server pings every 30 s, terminates dead clients) — catches it within ~30–60 s either way.
- **Frontend visibility-driven probe** — on `visibilitychange → visible`, send an app-level ping with a 3-second timeout; if no pong, force-close to trigger reconnect immediately. So the worst case after coming back from a long lock-screen is ~3 s of "reconnecting…" banner, then back to a working terminal.

You'll see a small banner top-of-screen during reconnects: `reconnecting in 1s…`. Once connected, all your tabs re-subscribe automatically.

## Mobile-specific shortcuts inside terminalcat

Tabs:

- Tap a tab → switch to it
- Tap `+` → new session
- Long-press a tab → rename / kill (with confirm)
- Active tab is centered into view on switch (so you can always see it on a narrow screen)

Tab bar scrolls horizontally on overflow rather than wrapping (each tab keeps its full width and fits a thumb).

## Browsers tested

| Browser | Status |
|---|---|
| iOS Safari 16+ | ✅ primary target |
| Android Chrome 12+ | ✅ |
| iOS Chrome / Edge / Firefox | should work (they all use Safari's WebKit on iOS) but less fully tested |
| Mobile Firefox (Android) | works; pinch-zoom occasionally tries to zoom the page despite our CSS |

Desktop browsers all work fine. The mobile UI gracefully widens; the
helper bar shows on touch devices only.

## Known mobile-Safari quirks

- WebGL renderer can fail to initialise the first time after a fresh install; a refresh fixes it. The fallback to canvas is automatic; you'll see a one-line `console.warn` and that's it.
- After a multi-hour lock-screen, the first visibility-probe ping sometimes takes 5+ seconds (TCP fast-retransmit). Subsequent ones are instant. Acceptable trade-off.
- Long-running uploads (>1 minute) can be killed if you switch away from the PWA — iOS suspends it. We don't have resumable uploads (yet); manually re-upload if you see one fail.
