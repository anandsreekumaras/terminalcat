#!/usr/bin/env bash
# terminalcat — pull, build, restart.
#
# Eliminates the "I forgot to rebuild after git pull" footgun on the
# compiled-deployment path (where systemd runs `node dist/server.js`,
# not `tsx src/server.ts`). Idempotent. Safe to run repeatedly.
#
# Usage:
#   scripts/update.sh            # default: pull main, build, restart
#   scripts/update.sh --no-pull  # skip git pull (rebuild after a manual edit)
#   scripts/update.sh --no-restart  # build only, don't bounce the service

set -euo pipefail

cd "$(dirname "$0")/.."

DO_PULL=1
DO_RESTART=1
for arg in "$@"; do
  case "$arg" in
    --no-pull)    DO_PULL=0 ;;
    --no-restart) DO_RESTART=0 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *)
      echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Refuse to run if the working tree is dirty AND we're about to pull. A
# clean pull-rebuild is what this script does; conflicting with local edits
# is what `git pull` does poorly. Bail with a clear message.
if [ "$DO_PULL" = 1 ] && [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree has uncommitted changes:" >&2
  git status --short >&2
  echo "  commit, stash, or run with --no-pull" >&2
  exit 1
fi

if [ "$DO_PULL" = 1 ]; then
  echo "→ git pull --ff-only origin main"
  git pull --ff-only origin main
fi

echo "→ pnpm install --prod=false"
pnpm install --frozen-lockfile

echo "→ pnpm build"
pnpm build

# Only restart systemd if the unit exists AND the user has sudo. On a fresh
# checkout the service may not be installed yet — skip silently in that case.
if [ "$DO_RESTART" = 1 ] && systemctl list-unit-files terminalcat.service >/dev/null 2>&1; then
  if sudo -n true 2>/dev/null; then
    echo "→ sudo systemctl restart terminalcat"
    sudo systemctl restart terminalcat
    sleep 1
    if sudo systemctl is-active --quiet terminalcat; then
      echo "✓ terminalcat is active"
    else
      echo "✗ terminalcat failed to start — check: sudo journalctl -u terminalcat -n 40" >&2
      exit 1
    fi
  else
    echo "  (sudo would prompt — skipping restart. Run manually:"
    echo "      sudo systemctl restart terminalcat"
    echo "   ).)"
  fi
fi

echo "✓ done"
