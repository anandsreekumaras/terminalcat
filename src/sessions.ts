// tmux talker. Source-of-truth helpers for "which sessions exist?" and
// "kill this session". Per spec: tmux is the source of truth, not our
// in-memory state.
//
// All functions here are pure I/O against the tmux server — they don't
// touch the WS / PTY tracking the application does in server.ts.

import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import { isValidSessionId } from './protocol';

export interface SessionInfo {
  id: string;
  /** Unix epoch seconds when tmux created the session. */
  createdAt: number;
  /** True iff at least one client is attached to the session right now. */
  attached: boolean;
}

/**
 * Run `tmux list-sessions -F` with a parseable format and return the parsed
 * results. If the tmux server isn't running yet (no sessions ever created),
 * tmux exits 1 with "no server running on …" — we treat that as an empty
 * list, not an error.
 */
export function listSessions(): Promise<SessionInfo[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}|#{session_created}|#{?session_attached,1,0}',
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        const sessions: SessionInfo[] = [];
        for (const line of out.split('\n')) {
          if (!line) continue;
          const parts = line.split('|');
          if (parts.length !== 3) continue;
          const id = parts[0]!;
          const createdAt = Number(parts[1]);
          const attached = parts[2] === '1';
          if (isValidSessionId(id) && Number.isFinite(createdAt)) {
            sessions.push({ id, createdAt, attached });
          }
          // Sessions that fail isValidSessionId are silently dropped from
          // listing — they exist on the tmux server but we can't safely
          // refer to them via the wire protocol. Logged so we know.
          else if (Number.isFinite(createdAt)) {
            console.warn(`[sessions] skipping tmux session with disallowed id: ${id}`);
          }
        }
        resolve(sessions);
      } else if (/no server running/i.test(err)) {
        resolve([]);
      } else {
        reject(new Error(`tmux list-sessions exit=${code}: ${err.trim()}`));
      }
    });
  });
}

/**
 * Rename a tmux session. Validates both ids. Reject if old doesn't exist
 * or new already exists (tmux refuses both — we just propagate).
 */
export function renameTmuxSession(oldId: string, newId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidSessionId(oldId)) {
      reject(new Error(`invalid old session id: ${JSON.stringify(oldId)}`));
      return;
    }
    if (!isValidSessionId(newId)) {
      reject(new Error(`invalid new session id: ${JSON.stringify(newId)}`));
      return;
    }
    const child = spawn('tmux', ['rename-session', '-t', oldId, newId]);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux rename-session exit=${code}: ${err.trim()}`));
    });
  });
}

/**
 * Best-effort `tmux set-option -g mouse on` against any running tmux server.
 * Why: without `mouse on`, scrolling inside tmux sends ↑/↓ to the inner
 * shell (= command history), not tmux's scrollback. Idempotent. If no
 * tmux server is running yet, the command exits 1 and we just log; the
 * very first session we create will start a server, and we should rerun
 * this then to be safe.
 */
export function ensureTmuxMouseOn(): Promise<void> {
  return setTmuxMouse(true);
}

/**
 * Rebind tmux's mouse-drag-end behaviour so the selection STAYS VISIBLE
 * after release.
 *
 * Default `MouseDragEnd1Pane` in tmux 3.x runs `copy-selection-and-cancel`,
 * which copies the selected text into tmux's buffer AND immediately exits
 * copy-mode — the visible highlight disappears the moment you let go of
 * the mouse button. Confusing for anyone used to "drag = select, stays
 * highlighted until I do something else".
 *
 * `copy-selection-no-clear` does the copy without the cancel, so the
 * selection persists until you press Escape, click elsewhere, or start
 * another drag. We rebind it for both `copy-mode` (emacs) and
 * `copy-mode-vi`, so the fix works regardless of the user's tmux
 * keybinding mode.
 */
export function keepTmuxSelectionAfterDrag(): Promise<void> {
  // Two bindings, applied in both `copy-mode` (emacs) and `copy-mode-vi`:
  //
  // 1. MouseDragEnd1Pane → copy-selection-no-clear
  //      Default is copy-selection-and-cancel which exits copy-mode and
  //      kills the highlight on mouse release. -no-clear keeps it.
  //
  // 2. MouseDown1Pane → cancel
  //      Once we've kept the selection visible, the user expects a click
  //      somewhere else to clear it (gnome-terminal / iTerm / xterm behave
  //      this way). Default in tmux's copy-mode is to clear the selection
  //      but STAY in copy-mode, which means subsequent clicks don't go to
  //      the shell — until the user presses Ctrl-C / q / Esc to escape.
  //      Binding to `cancel` exits copy-mode entirely on a single click,
  //      which is what users expect.
  const tables = ['copy-mode', 'copy-mode-vi'];
  const tasks: string[][] = [];
  for (const t of tables) {
    tasks.push(['bind-key', '-T', t, 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection-no-clear']);
    tasks.push(['bind-key', '-T', t, 'MouseDown1Pane',    'send-keys', '-X', 'cancel']);
  }
  return Promise.all(tasks.map((args) => new Promise<void>((resolve) => {
    const child = spawn('tmux', args);
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  }))).then(() => {
    console.log('[tmux] mouse: drag keeps selection, click cancels copy-mode');
  });
}

/**
 * Bridge tmux's selection to the BROWSER clipboard via OSC 52.
 *
 * Without this, `copy-selection-no-clear` (set in keepTmuxSelectionAfter
 * Drag) copies the selection only into tmux's INTERNAL buffer — useful
 * inside tmux (`Ctrl-b ]` to paste) but invisible to the rest of the OS.
 * Users dragging text expect Cmd-V / Ctrl-V to paste it ANYWHERE.
 *
 * The OSC 52 path:
 *   1. `set-clipboard on` tells tmux to emit `ESC ] 52 ; c ; <base64> BEL`
 *      whenever a copy action runs.
 *   2. terminal-overrides `Ms=…` tells tmux that the outer terminal
 *      (xterm.js, which we report as xterm-256color via node-pty's `name`)
 *      can handle that escape — terminfo's `Ms` capability sometimes
 *      isn't set on the host's xterm-256color entry, so we override.
 *   3. xterm.js receives the escape and a JS handler in
 *      public/index.html (registered per-Session) decodes the base64
 *      and calls `navigator.clipboard.writeText`. Only works in a
 *      user-gesture context — the mouse-drag-end IS one.
 */
/**
 * One-line-per-wheel-tick scrolling in copy-mode.
 *
 * tmux's default copy-mode wheel bindings scroll FIVE lines per wheel tick
 * (`send-keys -X -N 5 scroll-up`). On a precision wheel / trackpad detent,
 * that feels like the scroll position jumps "+5" or "-5" lines at a time
 * instead of moving smoothly with the user's wheel. Rebind to scroll
 * exactly one line per wheel tick.
 *
 * Applied in both `copy-mode` (emacs-style, our default mode-keys) and
 * `copy-mode-vi`, so the binding takes regardless of which the user
 * has set via mode-keys.
 */
export function setTmuxScrollStepOne(): Promise<void> {
  const tables = ['copy-mode', 'copy-mode-vi'];
  const tasks: string[][] = [];
  for (const t of tables) {
    // -N 1 is technically redundant (scroll-up defaults to 1 line when
    // count is unspecified) but explicit > implicit when overriding a
    // default that was explicit in the other direction.
    tasks.push(['bind-key', '-T', t, 'WheelUpPane',   'select-pane', '\\;', 'send-keys', '-X', '-N', '1', 'scroll-up']);
    tasks.push(['bind-key', '-T', t, 'WheelDownPane', 'select-pane', '\\;', 'send-keys', '-X', '-N', '1', 'scroll-down']);
  }
  return Promise.all(tasks.map((args) => new Promise<void>((resolve) => {
    const child = spawn('tmux', args);
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  }))).then(() => {
    console.log('[tmux] copy-mode wheel: 1 line per tick (was 5)');
  });
}

export function enableTmuxClipboard(): Promise<void> {
  const cmds: string[][] = [
    ['set-option', '-g', 'set-clipboard', 'on'],
    [
      'set-option', '-ga', 'terminal-overrides',
      ',xterm-256color:Ms=\\E]52;c;%p2%s\\E\\\\,tmux-256color:Ms=\\E]52;c;%p2%s\\E\\\\',
    ],
  ];
  return Promise.all(cmds.map((args) => new Promise<void>((resolve) => {
    const c = spawn('tmux', args);
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  }))).then(() => {
    console.log('[tmux] set-clipboard on (OSC 52 -> browser clipboard)');
  });
}

/**
 * Hide tmux's built-in green status bar — terminalcat replaces it with
 * its own #info-bar that knows the WS client count and source IP, which
 * tmux can't see. Idempotent.
 */
export function disableTmuxStatus(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['set-option', '-g', 'status', 'off']);
    child.on('error', () => resolve());
    child.on('close', (code) => {
      if (code === 0) console.log('[tmux] status bar hidden');
      resolve();
    });
  });
}

/**
 * Toggle / set tmux's global `mouse` option. With mouse on, scroll wheel
 * scrolls tmux's own scrollback and selection requires Shift+click. With
 * mouse off, the scroll wheel sends ↑/↓ keys (= command history) but
 * selection works natively in xterm without Shift.
 *
 * Resolves with the new state on success, or null on failure (no tmux
 * server, etc).
 */
export function setTmuxMouse(on: boolean): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('tmux', ['set-option', '-g', 'mouse', on ? 'on' : 'off']);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', () => resolve());
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[tmux] mouse=${on ? 'on' : 'off'} applied`);
      } else if (/no server running/i.test(err)) {
        console.log(`[tmux] no server yet; mouse=${on ? 'on' : 'off'} will apply on first spawn`);
      } else {
        console.warn(`[tmux] set mouse ${on ? 'on' : 'off'} exit=${code}: ${err.trim()}`);
      }
      resolve();
    });
  });
}

/**
 * Unbind tmux's default split-pane keys (Ctrl-b `%`, Ctrl-b `"`, etc.).
 * The terminalcat UI uses tabs for multiplexing — accidentally hitting
 * a tmux split key creates a pane that can't be reached via the tabs
 * model. Idempotent and silent if no tmux server is running.
 */
export function disableTmuxSplits(): Promise<void> {
  // unbind-key takes one arg; run them in parallel.
  const keys = ['%', '"', "'", 'h', 'v'];
  return Promise.all(keys.map((k) => new Promise<void>((resolve) => {
    const c = spawn('tmux', ['unbind-key', k]);
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  }))).then(() => {
    console.log('[tmux] split-pane keys unbound');
  });
}

/**
 * Disable tmux's own right-click context menu inside the terminal.
 *
 * tmux 3.0+ binds `MouseDown3Pane` (and `MouseDown3Status*`) to a
 * `display-menu` action that draws a tmux-internal menu — Go to top,
 * Search, Copy line, Horizontal Split, Vertical Split, Kill, …
 *
 * On terminalcat we have our own browser-level right-click menu (Copy /
 * Paste / Select all / Search / Clear / Detach). With tmux's menu also
 * firing on the same right-click, the user sees TWO stacked menus.
 * Unbind tmux's so only ours appears.
 */
export function disableTmuxRightClickMenu(): Promise<void> {
  // Plain MouseDown3Pane is the obvious one. tmux ALSO ships modifier-
  // prefixed variants — Alt/Meta + right-click (`M-MouseDown3Pane`) and
  // Ctrl + right-click — that bind the same display-menu. On macOS,
  // Cmd+right-click can be forwarded as Meta, which fires the M- variant.
  // Sweep them all to be sure.
  const keys = [
    'MouseDown3Pane',
    'M-MouseDown3Pane',
    'C-MouseDown3Pane',
    'S-MouseDown3Pane',
    'MouseDown3Status',
    'MouseDown3StatusLeft',
    'MouseDown3StatusRight',
    'M-MouseDown3Status',
  ];
  return Promise.all(keys.map((k) => new Promise<void>((resolve) => {
    const c = spawn('tmux', ['unbind-key', '-T', 'root', k]);
    c.on('error', () => resolve());
    c.on('close', () => resolve());
  }))).then(() => {
    console.log('[tmux] right-click menus unbound (incl. Alt/Cmd/Ctrl modifiers)');
  });
}

/** `tmux kill-session -t <id>`. Resolves on success, rejects on failure. */
export function killTmuxSession(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isValidSessionId(id)) {
      reject(new Error(`invalid session id: ${JSON.stringify(id)}`));
      return;
    }
    const child = spawn('tmux', ['kill-session', '-t', id]);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tmux kill-session exit=${code}: ${err.trim()}`));
    });
  });
}

/**
 * Spawn a PTY child running `tmux new -A -s <id>`. -A attaches if the session
 * already exists, creating it if not. The caller owns the lifecycle (onData,
 * onExit, kill) — we just construct the IPty.
 */
export function spawnPtyForSession(
  id: string,
  cols: number,
  rows: number,
  env: { [key: string]: string },
  cwd: string,
): pty.IPty {
  if (!isValidSessionId(id)) {
    throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  }
  return pty.spawn('tmux', ['new', '-A', '-s', id], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    // encoding:null hands us raw Buffer in onData instead of a UTF-8 string.
    // We re-pack the bytes as a binary WS frame anyway, so the string path
    // forced an extra decode+encode round-trip that we now skip. node-pty's
    // .d.ts insists `data: string` regardless — server.ts casts at the call
    // site with a comment.
    encoding: null,
  });
}
