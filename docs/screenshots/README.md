# Screenshots

These are the images linked from the project README. Replace with your own
captures from a running terminalcat instance — the placeholders below are
ASCII mockups so the README isn't empty-image-shaped on day 1.

## What to capture

Suggested set (1280×800 or thereabouts on desktop, native phone resolution
on mobile, PNG):

| File | What it should show |
|---|---|
| `desktop-tabs.png`     | Full window, several tabs in the top bar, terminal in the middle running `htop` or `ls --color` so the colors are obvious, info bar at the bottom showing device count + cwd |
| `desktop-rightclick.png` | Right-click context menu open over the terminal area (Copy / Paste / Select all / Search / Clear / Detach) |
| `desktop-search.png`   | Ctrl+Shift+F search bar visible at the top right with a match highlighted in scrollback |
| `desktop-upload.png`   | Drag-and-drop in progress — the blue inset border on `#panes` plus a transfer card bottom-right |
| `mobile-portrait.png`  | iOS Safari (or Chrome Android) in standalone PWA mode, helper bar visible above the keyboard with Esc/Tab/Ctrl/Alt/arrows/^A/^C/^D |
| `mobile-actionsheet.png` | Long-press action sheet sliding up from the bottom (Paste / Copy / Clear / Detach / Cancel) |
| `mobile-installprompt.png` | The "Install app" / "Add to Home Screen" prompt — proves PWA installability |

## How to add

1. Capture (`Cmd-Shift-4` on macOS, `gnome-screenshot -a` on GNOME, native
   screen capture on iOS/Android).
2. Rename to one of the filenames above and drop into this directory.
3. The README's "Screenshots" section already references those paths —
   nothing else to change.
4. Commit + push.

PRs welcome if you want to contribute screenshots from a deployment that
isn't mine.
