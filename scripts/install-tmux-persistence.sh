#!/usr/bin/env bash
# Install tmux-resurrect + tmux-continuum so tmux sessions survive
# reboots / tmux server restarts.
#
# After running this:
#   - Continuum auto-saves the session graph every 15 min to
#     ~/.tmux/resurrect/last
#   - On tmux server start (first `tmux new …` after a reboot), continuum
#     restores from that snapshot
#
# What's saved:
#   sessions, windows, panes, working dir, command names. Optionally
#   pane CONTENT too (off by default — adds disk + can leak secrets).
#
# What's NOT saved:
#   process state. A running nuclei scan is killed by the reboot;
#   continuum re-runs `nuclei` but it starts over.
#
# Idempotent — safe to re-run.

set -euo pipefail

PLUGIN_DIR="$HOME/.tmux/plugins"
RESURRECT_DIR="$PLUGIN_DIR/tmux-resurrect"
CONTINUUM_DIR="$PLUGIN_DIR/tmux-continuum"
TMUX_CONF="$HOME/.tmux.conf"
MARKER_BEGIN="# >>> terminalcat tmux-persistence (managed) >>>"
MARKER_END="# <<< terminalcat tmux-persistence (managed) <<<"

red()    { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
info()   { printf '  › %s\n' "$*"; }
ok()     { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }

command -v git >/dev/null 2>&1 || { red "✗ git not installed"; exit 1; }
command -v tmux >/dev/null 2>&1 || { red "✗ tmux not installed"; exit 1; }

mkdir -p "$PLUGIN_DIR"

# ----- clone / update plugins ---------------------------------------------
clone_or_update() {
  local url="$1" dst="$2" name
  name=$(basename "$dst")
  if [ -d "$dst/.git" ]; then
    info "updating $name…"
    git -C "$dst" pull --ff-only --quiet || yellow "  pull failed (custom branch?) — skipping"
  else
    info "cloning $name…"
    git clone --depth 1 --quiet "$url" "$dst"
  fi
  ok "$name"
}

clone_or_update https://github.com/tmux-plugins/tmux-resurrect.git "$RESURRECT_DIR"
clone_or_update https://github.com/tmux-plugins/tmux-continuum.git "$CONTINUUM_DIR"

# ----- ensure the config block is present in ~/.tmux.conf -----------------
# We use marker comments so re-running the installer doesn't keep
# appending duplicate blocks. Removing the block (to uninstall) is just
# `sed -i '/MARKER_BEGIN/,/MARKER_END/d' ~/.tmux.conf`.

CONFIG_BLOCK=$(cat <<EOF
$MARKER_BEGIN
# Auto-installed by terminalcat's scripts/install-tmux-persistence.sh.
# Edit between the markers if you want to tune; the installer leaves
# any user-added lines OUTSIDE the markers alone on re-run.

# Save pane contents too (off by default — flip to 'on' to capture the
# visible scrollback in each pane. Adds disk usage + can leak secrets
# from your scrollback into /home/<user>/.tmux/resurrect/, so think
# about what you'd be persisting).
set -g @resurrect-capture-pane-contents 'off'

# Bind a save / restore on the prefix in case continuum's auto-save
# missed the last 15 minutes (Ctrl-b Ctrl-s saves now; Ctrl-b Ctrl-r
# restores the last snapshot).

# How often continuum saves to disk (minutes).
set -g @continuum-save-interval '15'

# Auto-restore the latest snapshot when tmux server starts. THIS is the
# bit that makes sessions come back after a reboot.
set -g @continuum-restore 'on'

# Run the plugin scripts. We don't use TPM (tmux-plugin-manager) here;
# we run the plugin's own .tmux entrypoint directly so this works
# whether you have TPM or not.
run-shell "$RESURRECT_DIR/resurrect.tmux"
run-shell "$CONTINUUM_DIR/continuum.tmux"
$MARKER_END
EOF
)

# Create the config file if missing
[ -f "$TMUX_CONF" ] || touch "$TMUX_CONF"

if grep -qF "$MARKER_BEGIN" "$TMUX_CONF"; then
  info "block already present in $TMUX_CONF — replacing it"
  # Remove the existing block, then append fresh
  python3 - <<PY
import re, pathlib
p = pathlib.Path("$TMUX_CONF")
text = p.read_text()
new = re.sub(
    r"\n?$MARKER_BEGIN.*?$MARKER_END\n?",
    "",
    text,
    flags=re.DOTALL,
)
p.write_text(new)
PY
fi

printf '\n%s\n' "$CONFIG_BLOCK" >> "$TMUX_CONF"
ok "wrote managed block to $TMUX_CONF"

# ----- reload running tmux server (if any) so settings apply now ----------
if tmux info >/dev/null 2>&1; then
  info "reloading running tmux server…"
  tmux source-file "$TMUX_CONF" || yellow "  source-file failed — restart tmux to apply"
  ok "tmux config reloaded"
else
  info "no tmux server running yet — settings will apply on first session start"
fi

echo ""
green "✓ tmux session persistence installed."
echo "  Sessions auto-save every 15 min to ~/.tmux/resurrect/"
echo "  On the next box reboot, the latest snapshot will auto-restore on first tmux start."
echo ""
echo "  To disable: edit $TMUX_CONF and remove the block between the markers,"
echo "  or just delete $RESURRECT_DIR and $CONTINUUM_DIR."
