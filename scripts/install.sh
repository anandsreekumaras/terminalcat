#!/usr/bin/env bash
# terminalcat installer — auto-installs prerequisites across distros.
#
# Sets up a fresh terminalcat install on a Linux box:
#   1. Detects OS / package manager (apt / dnf / yum / pacman)
#   2. Installs missing prerequisites:
#        - Node.js 20 LTS (via NodeSource if absent)
#        - pnpm (via corepack)
#        - tmux, git, build tools (gcc, make, python3 — node-pty compiles
#          on aarch64), cloudflared
#   3. Clones / updates the repo
#   4. pnpm install (compiles node-pty from source on aarch64)
#   5. Prompts for Cloudflare Access env vars and writes .env
#   6. Optionally installs the systemd unit
#   7. Optionally symlinks webdl / webnotify / discord-notify into /usr/local/bin
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/anandsreekumaras/terminalcat/main/scripts/install.sh | bash
#
# After cloning manually:
#   ./scripts/install.sh
#
# Knobs (set as env vars before running):
#   TERMINALCAT_REPO  — git URL (default: this repo)
#   TERMINALCAT_DIR   — where to install (default: $HOME/terminalcat)
#   ASSUME_YES=1      — auto-accept all "install missing X?" prompts
#
# Idempotent. Safe to re-run.

set -euo pipefail

# ===== knobs ===============================================================
REPO_URL="${TERMINALCAT_REPO:-https://github.com/anandsreekumaras/terminalcat.git}"
INSTALL_DIR="${TERMINALCAT_DIR:-$HOME/terminalcat}"
ASSUME_YES="${ASSUME_YES:-0}"

NODE_MIN_MAJOR=20
NODE_INSTALL_VERSION="20"   # used if we install Node ourselves

# ===== output helpers ======================================================
red()    { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[0;34m%s\033[0m\n' "$*"; }
cyan()   { printf '\033[0;36m%s\033[0m\n' "$*"; }
info()   { printf '  › %s\n' "$*"; }
ok()     { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
warn()   { printf '  \033[0;33m⚠\033[0m %s\n' "$*"; }
abort()  { red "✗ $*"; exit 1; }

confirm() {
  local prompt="$1"
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  read -r -p "  $prompt [y/N] " ans </dev/tty
  case "${ans:-n}" in y|Y|yes|YES) return 0;; *) return 1;; esac
}

need_sudo() {
  if [ "$(id -u)" = "0" ]; then return 0; fi
  command -v sudo >/dev/null 2>&1 || abort "need sudo to install packages but sudo not present"
}

# ===== distro / package-manager detection =================================
PKG_MGR=""
PKG_INSTALL=""
PKG_UPDATE=""
DISTRO=""

detect_pm() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO="${ID:-unknown}"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    PKG_MGR=apt;     PKG_INSTALL="sudo apt-get install -y";       PKG_UPDATE="sudo apt-get update"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MGR=dnf;     PKG_INSTALL="sudo dnf install -y";            PKG_UPDATE="sudo dnf -y makecache"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MGR=yum;     PKG_INSTALL="sudo yum install -y";            PKG_UPDATE="sudo yum -y makecache"
  elif command -v pacman >/dev/null 2>&1; then
    PKG_MGR=pacman;  PKG_INSTALL="sudo pacman -S --needed --noconfirm"; PKG_UPDATE="sudo pacman -Sy"
  elif command -v zypper >/dev/null 2>&1; then
    PKG_MGR=zypper;  PKG_INSTALL="sudo zypper install -y";         PKG_UPDATE="sudo zypper refresh"
  elif command -v apk >/dev/null 2>&1; then
    PKG_MGR=apk;     PKG_INSTALL="sudo apk add --no-cache";        PKG_UPDATE="sudo apk update"
  else
    abort "no supported package manager found (need apt / dnf / yum / pacman / zypper / apk)"
  fi
  ok "package manager: $PKG_MGR (distro: $DISTRO)"
}

pkg_install() {
  # arg1+: package names. Maps generic names to per-distro names.
  local args=()
  for p in "$@"; do
    case "$p:$PKG_MGR" in
      build-essential:dnf|build-essential:yum)        args+=(gcc gcc-c++ make);;
      build-essential:pacman)                          args+=(base-devel);;
      build-essential:zypper)                          args+=(gcc gcc-c++ make);;
      build-essential:apk)                             args+=(build-base);;
      python3:apk)                                     args+=(python3);;
      ca-certificates:apk)                             args+=(ca-certificates);;
      curl:apk)                                        args+=(curl);;
      *) args+=("$p");;
    esac
  done
  need_sudo
  $PKG_UPDATE >/dev/null 2>&1 || true
  $PKG_INSTALL "${args[@]}"
}

# ===== prerequisite installs ==============================================
install_node() {
  # Try the cleanest distro-supplied path first, then NodeSource (Debian/RHEL),
  # then nvm as a last resort.
  if [ "$PKG_MGR" = "apt" ]; then
    info "adding NodeSource Node $NODE_INSTALL_VERSION repo…"
    need_sudo
    sudo install -d -m 0755 /etc/apt/keyrings
    curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
      | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_INSTALL_VERSION}.x nodistro main" \
      | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    sudo apt-get update >/dev/null
    sudo apt-get install -y nodejs
  elif [ "$PKG_MGR" = "dnf" ] || [ "$PKG_MGR" = "yum" ]; then
    info "adding NodeSource Node $NODE_INSTALL_VERSION repo…"
    need_sudo
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_INSTALL_VERSION}.x" | sudo bash -
    pkg_install nodejs
  elif [ "$PKG_MGR" = "pacman" ]; then
    pkg_install nodejs npm
  elif [ "$PKG_MGR" = "zypper" ]; then
    pkg_install "nodejs${NODE_INSTALL_VERSION}" npm
  elif [ "$PKG_MGR" = "apk" ]; then
    pkg_install nodejs npm
  else
    info "no supported repo path — falling back to nvm…"
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm install "$NODE_INSTALL_VERSION"
    nvm use "$NODE_INSTALL_VERSION"
  fi
}

install_cloudflared() {
  case "$PKG_MGR" in
    apt)
      need_sudo
      sudo install -d -m 0755 /etc/apt/keyrings
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
        | sudo tee /etc/apt/keyrings/cloudflare-main.gpg >/dev/null
      echo "deb [signed-by=/etc/apt/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $( . /etc/os-release && echo "${VERSION_CODENAME:-bookworm}" ) main" \
        | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
      sudo apt-get update >/dev/null
      sudo apt-get install -y cloudflared
      ;;
    dnf|yum)
      need_sudo
      curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo \
        | sudo tee /etc/yum.repos.d/cloudflared.repo >/dev/null
      pkg_install cloudflared
      ;;
    pacman)
      warn "cloudflared is in AUR — install via your AUR helper:"
      info "  yay -S cloudflared-bin"
      ;;
    *)
      warn "no automatic cloudflared install for $PKG_MGR — fetching the static binary"
      install_cloudflared_static
      ;;
  esac
}

install_cloudflared_static() {
  # Fall-back: download the linux/amd64 (or arm64) static binary into /usr/local/bin.
  local arch
  case "$(uname -m)" in
    x86_64) arch=amd64;;
    aarch64|arm64) arch=arm64;;
    armv7l) arch=arm;;
    *) abort "unsupported arch $(uname -m) for cloudflared static install";;
  esac
  need_sudo
  sudo curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" \
    -o /usr/local/bin/cloudflared
  sudo chmod +x /usr/local/bin/cloudflared
}

# ===== prerequisite checks ================================================
check_or_install_curl() {
  command -v curl >/dev/null 2>&1 && { ok "curl"; return; }
  warn "curl missing"
  if confirm "install curl via $PKG_MGR?"; then
    pkg_install curl ca-certificates
    ok "curl installed"
  else
    abort "curl required to fetch upstream packages"
  fi
}

check_or_install_git() {
  command -v git >/dev/null 2>&1 && { ok "git $(git --version | awk '{print $3}')"; return; }
  warn "git missing"
  if confirm "install git via $PKG_MGR?"; then
    pkg_install git
    ok "git installed"
  else
    abort "git required to clone the repo"
  fi
}

check_or_install_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    ok "tmux $(tmux -V 2>&1 | grep -oE '[0-9]+\.[0-9]+[a-z]?' | head -1)"
    return
  fi
  warn "tmux missing"
  if confirm "install tmux via $PKG_MGR?"; then
    pkg_install tmux
    ok "tmux installed"
  else
    abort "tmux is mandatory — terminalcat depends on it for session persistence"
  fi
}

check_or_install_node() {
  if command -v node >/dev/null 2>&1; then
    local v
    v=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$v" -ge "$NODE_MIN_MAJOR" ]; then
      ok "Node $(node --version)"
      return
    fi
    warn "Node $(node --version) is too old (need >= $NODE_MIN_MAJOR.x)"
  else
    warn "Node.js missing"
  fi
  if confirm "install Node $NODE_INSTALL_VERSION LTS?"; then
    install_node
    ok "Node $(node --version)"
  else
    abort "Node $NODE_MIN_MAJOR+ required"
  fi
}

check_or_install_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm --version)"
    return
  fi
  if command -v corepack >/dev/null 2>&1; then
    info "enabling pnpm via corepack (bundled with Node 16.13+)…"
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1
    ok "pnpm $(pnpm --version)"
    return
  fi
  warn "pnpm and corepack both missing — falling back to npm install -g"
  if confirm "install pnpm via npm -g?"; then
    npm install -g pnpm
    ok "pnpm $(pnpm --version)"
  else
    abort "pnpm required"
  fi
}

check_or_install_build_tools() {
  if [ "$(uname -m)" != "aarch64" ] && [ "$(uname -m)" != "arm64" ]; then
    return  # node-pty has prebuilds for x86_64; no compile needed
  fi
  if command -v cc >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    ok "build tools (cc + python3)"
    return
  fi
  warn "node-pty has no aarch64 prebuild — needs build tools to compile"
  if confirm "install build-essential + python3 via $PKG_MGR?"; then
    pkg_install build-essential python3
    ok "build tools installed"
  else
    abort "build tools required for node-pty on aarch64"
  fi
}

check_or_install_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    ok "cloudflared $(cloudflared --version 2>&1 | grep -oE '[0-9]+\.[0-9.]+' | head -1)"
    return
  fi
  warn "cloudflared missing — terminalcat will run on 127.0.0.1:7682 but you need a tunnel + Access to expose it"
  if confirm "install cloudflared via official repo?"; then
    install_cloudflared
    ok "cloudflared installed"
  else
    info "skipping. install later from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  fi
}

# ===== repo ===============================================================
clone_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "updating existing checkout at $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only || warn "git pull failed (custom branch?) — continuing with whatever's checked out"
  elif [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
    info "using existing copy at $INSTALL_DIR (no .git)"
  else
    info "cloning $REPO_URL → $INSTALL_DIR"
    git clone --depth 50 "$REPO_URL" "$INSTALL_DIR"
  fi
  ok "repo at $INSTALL_DIR"
}

install_deps() {
  info "running pnpm install (compiles node-pty on aarch64 — may take a minute)…"
  cd "$INSTALL_DIR"
  pnpm install
  ok "deps installed"
}

# ===== env ================================================================
prompt_env() {
  local env_file="$INSTALL_DIR/.env"
  local existing_team_domain="" existing_aud="" existing_log_dir="" existing_origin=""

  if [ -f "$env_file" ]; then
    yellow "  ⚠ $env_file already exists — current values shown as defaults; press Enter to keep"
    existing_team_domain=$(grep -E '^CF_ACCESS_TEAM_DOMAIN=' "$env_file" | head -1 | cut -d= -f2- || true)
    existing_aud=$(grep -E '^CF_ACCESS_AUD=' "$env_file" | head -1 | cut -d= -f2- || true)
    existing_log_dir=$(grep -E '^LOG_DIR=' "$env_file" | head -1 | cut -d= -f2- || true)
    existing_origin=$(grep -E '^ALLOWED_ORIGIN=' "$env_file" | head -1 | cut -d= -f2- || true)
  fi

  blue ""
  blue "→ Cloudflare Access env vars"
  echo "  Find these in https://one.dash.cloudflare.com/"
  echo "    Team domain → Settings > General > Team domain  (the part before .cloudflareaccess.com)"
  echo "    AUD tag     → Access > Applications > <your app> > Overview > Application Audience Tag"
  echo "  See README.md \"Cloudflare setup\" for a full walkthrough."

  local team_domain aud log_dir allowed_origin

  read -r -p "  CF_ACCESS_TEAM_DOMAIN${existing_team_domain:+ [$existing_team_domain]}: " team_domain </dev/tty
  team_domain=${team_domain:-$existing_team_domain}
  [ -z "$team_domain" ] && abort "CF_ACCESS_TEAM_DOMAIN is required"

  read -r -p "  CF_ACCESS_AUD${existing_aud:+ [<existing>]}: " aud </dev/tty
  aud=${aud:-$existing_aud}
  [ -z "$aud" ] && abort "CF_ACCESS_AUD is required"

  blue ""
  blue "→ ALLOWED_ORIGIN (recommended)"
  echo "  CSWSH defense-in-depth. Set to the canonical URL where users will load"
  echo "  terminalcat (e.g. https://shell.example.com). When set, WS upgrades"
  echo "  whose Origin header doesn't match get a 403. Cloudflare Access' default"
  echo "  SameSite=Lax cookie already blocks the obvious browser CSWSH path; this"
  echo "  hardens the SameSite=None edge case. Blank to skip (the check stays"
  echo "  disabled — fine in dev, recommended on for prod)."

  read -r -p "  ALLOWED_ORIGIN${existing_origin:+ [$existing_origin]} (blank to skip): " allowed_origin </dev/tty
  allowed_origin=${allowed_origin:-$existing_origin}
  if [ -n "$allowed_origin" ]; then
    # Add scheme if user typed bare hostname.
    if ! [[ "$allowed_origin" =~ ^https?:// ]]; then
      warn "ALLOWED_ORIGIN missing scheme — prepending https://"
      allowed_origin="https://$allowed_origin"
    fi
    # Warn on http (production should be https-only behind Cloudflare).
    if [[ "$allowed_origin" == http://* ]]; then
      warn "ALLOWED_ORIGIN is plain http — fine for dev, but production should be https"
    fi
    # Strip any trailing slash — the Origin header sent by browsers never has one,
    # so a trailing slash here would silently fail every check.
    allowed_origin="${allowed_origin%/}"
  fi

  read -r -p "  LOG_DIR (optional, blank to log to stderr only)${existing_log_dir:+ [$existing_log_dir]}: " log_dir </dev/tty
  log_dir=${log_dir:-$existing_log_dir}

  cat > "$env_file" <<EOF
# Generated by scripts/install.sh on $(date -Iseconds)
CF_ACCESS_TEAM_DOMAIN=$team_domain
CF_ACCESS_AUD=$aud
EOF
  if [ -n "$allowed_origin" ]; then echo "ALLOWED_ORIGIN=$allowed_origin" >> "$env_file"; fi
  if [ -n "$log_dir" ]; then echo "LOG_DIR=$log_dir" >> "$env_file"; fi

  chmod 600 "$env_file"
  ok "wrote $env_file (chmod 600)"
  if [ -z "$allowed_origin" ]; then
    yellow "  ↳ ALLOWED_ORIGIN not set: CSWSH defense disabled. Add later by appending"
    yellow "    ALLOWED_ORIGIN=https://your-host to .env and restarting the service."
  fi
}

# ===== systemd ============================================================
ask_systemd() {
  echo
  if ! command -v systemctl >/dev/null 2>&1; then
    info "systemd not present — skipping service install"
    return
  fi
  if ! confirm "install as a systemd service (Restart=always, runs on boot)?"; then
    info "skipping systemd. To start manually: \`cd $INSTALL_DIR && pnpm dev\`"
    return
  fi

  local svc_src="$INSTALL_DIR/deploy/terminalcat.service"
  local svc_dst="/etc/systemd/system/terminalcat.service"
  local user_id node_path
  user_id=$(id -u)
  node_path=$(command -v node)

  info "templating $svc_src → $svc_dst (User=$USER, Node=$node_path, RuntimeDir=/run/user/$user_id)"
  need_sudo
  sudo cp "$svc_src" "$svc_dst"
  sudo sed -i "s|/home/ubuntu/terminalcat|$INSTALL_DIR|g" "$svc_dst"
  sudo sed -i "s|^User=ubuntu|User=$USER|"      "$svc_dst"
  sudo sed -i "s|^Group=ubuntu|Group=$(id -gn)|" "$svc_dst"
  sudo sed -i "s|/home/ubuntu/.nvm/versions/node/v20.20.2/bin/node|$node_path|g" "$svc_dst"
  sudo sed -i "s|/run/user/1000|/run/user/$user_id|g" "$svc_dst"

  sudo systemctl daemon-reload
  sudo systemctl enable --now terminalcat.service

  sleep 1
  if sudo systemctl is-active --quiet terminalcat.service; then
    ok "terminalcat.service running on http://127.0.0.1:7682"
    info "logs: \`sudo journalctl -u terminalcat -f\`"
  else
    red "  ✗ terminalcat.service failed to start"
    info "diagnose: \`sudo systemctl status terminalcat\` / \`sudo journalctl -u terminalcat --no-pager -n 40\`"
  fi
}

# ===== cloudflared tunnel as a separate systemd service ===================
# Installs `deploy/cloudflared-terminalcat.service` if the user has already
# created their tunnel and config. Skips quietly if cloudflared isn't on
# the box yet, or if there's no ~/.cloudflared/terminalcat.yml — the
# next-steps summary tells the user how to come back.
#
# Why NOT `cloudflared service install`: that command installs ONE
# token-based unit and either collides with or overwrites any existing
# cloudflared.service on the box (e.g. one for codeserver). A dedicated,
# distinctly-named unit sits cleanly alongside.
ask_tunnel_systemd() {
  echo
  if ! command -v systemctl >/dev/null 2>&1; then
    info "systemd not present — skipping cloudflared tunnel service install"
    return
  fi
  if ! command -v cloudflared >/dev/null 2>&1; then
    info "cloudflared missing — skipping tunnel service. Install cloudflared, then re-run."
    return
  fi
  local cfg="$HOME/.cloudflared/terminalcat.yml"
  if [ ! -f "$cfg" ]; then
    info "cloudflared tunnel config $cfg not yet created — skipping tunnel service."
    info "  Run, in order:"
    info "    cloudflared login                              # one-time browser SSO"
    info "    cloudflared tunnel create terminalcat          # writes credentials JSON"
    info "    cloudflared tunnel route dns terminalcat shell.YOUR-DOMAIN"
    info "    mkdir -p ~/.cloudflared"
    info "    cp $INSTALL_DIR/deploy/cloudflared.yml $cfg"
    info "    \$EDITOR $cfg                                  # paste the UUID"
    info "    re-run this installer to register the tunnel as a systemd service."
    return
  fi
  if ! confirm "install systemd service for the cloudflared tunnel (so it survives reboot)?"; then
    info "skipping. To install later:"
    info "    sudo cp $INSTALL_DIR/deploy/cloudflared-terminalcat.service /etc/systemd/system/"
    info "    sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared-terminalcat.service"
    return
  fi

  local svc_src="$INSTALL_DIR/deploy/cloudflared-terminalcat.service"
  local svc_dst="/etc/systemd/system/cloudflared-terminalcat.service"
  info "templating $svc_src → $svc_dst (User=$USER, config=$cfg)"
  need_sudo
  sudo cp "$svc_src" "$svc_dst"
  sudo sed -i "s|^User=ubuntu|User=$USER|"                       "$svc_dst"
  sudo sed -i "s|^Group=ubuntu|Group=$(id -gn)|"                 "$svc_dst"
  sudo sed -i "s|/home/ubuntu/.cloudflared|$HOME/.cloudflared|g" "$svc_dst"

  sudo systemctl daemon-reload
  sudo systemctl enable --now cloudflared-terminalcat.service

  sleep 1
  if sudo systemctl is-active --quiet cloudflared-terminalcat.service; then
    ok "cloudflared-terminalcat.service running"
    info "logs: \`sudo journalctl -u cloudflared-terminalcat -f\`"
  else
    red "  ✗ cloudflared-terminalcat.service failed to start"
    info "diagnose: \`sudo systemctl status cloudflared-terminalcat\` / \`sudo journalctl -u cloudflared-terminalcat --no-pager -n 40\`"
  fi
}

# ===== shims ==============================================================
ask_shims() {
  echo
  if ! confirm "install webdl + webnotify + discord-notify CLI shims to /usr/local/bin?"; then
    info "skipping. You can do it later: \`sudo ln -sf $INSTALL_DIR/bin/webdl /usr/local/bin/\`"
    return
  fi
  need_sudo
  sudo ln -sf "$INSTALL_DIR/bin/webdl"          /usr/local/bin/webdl
  sudo ln -sf "$INSTALL_DIR/bin/webnotify"      /usr/local/bin/webnotify
  sudo ln -sf "$INSTALL_DIR/bin/discord-notify" /usr/local/bin/discord-notify
  ok "webdl + webnotify + discord-notify symlinked into /usr/local/bin"
  if ! [ -f "$HOME/.config/discord-webhook" ] && [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then
    info "↳ discord-notify is silent until you configure a webhook URL. To enable:"
    info "    mkdir -p ~/.config && echo 'https://discord.com/api/webhooks/...' > ~/.config/discord-webhook && chmod 600 ~/.config/discord-webhook"
  fi
}

# ===== summary ============================================================
print_next_steps() {
  echo
  green "═════════════════════════════════════════════════════════════"
  green "  terminalcat installed"
  green "═════════════════════════════════════════════════════════════"
  echo
  blue  "  Bound to:  http://127.0.0.1:7682  (loopback only)"
  echo
  cyan  "  What's left to do (one-time, on your Cloudflare account):"
  echo  "  1. Create a tunnel + DNS route:"
  echo  "       cloudflared login                                  # one-time browser SSO"
  echo  "       cloudflared tunnel create terminalcat              # writes credentials JSON"
  echo  "       cloudflared tunnel route dns terminalcat shell.YOUR-DOMAIN"
  echo  "  2. Make a per-machine config from the template:"
  echo  "       mkdir -p ~/.cloudflared"
  echo  "       cp $INSTALL_DIR/deploy/cloudflared.yml ~/.cloudflared/terminalcat.yml"
  echo  "       \$EDITOR ~/.cloudflared/terminalcat.yml             # paste the tunnel UUID"
  echo  "  3. Re-run THIS installer once that file exists — it'll register the tunnel"
  echo  "       as a systemd service (cloudflared-terminalcat.service) so it survives"
  echo  "       reboots. For testing without systemd:"
  echo  "       cloudflared tunnel --config ~/.cloudflared/terminalcat.yml run"
  echo  "  4. Create a Cloudflare Access app for shell.YOUR-DOMAIN"
  echo  "     (Zero Trust dashboard → Access → Applications → Self-hosted, allow your email)"
  echo  "  5. Visit https://shell.YOUR-DOMAIN → SSO login → terminal."
  echo
  yellow "  ⚠ DON'T use \`sudo cloudflared service install\` — that command installs a"
  yellow "    token-based unit that collides with any existing cloudflared.service on"
  yellow "    the box, and uses tokens (rotate on dashboard refresh) instead of the"
  yellow "    credentials-file pattern this project ships."
  echo
  cyan  "  Full walkthrough in $INSTALL_DIR/README.md"
  echo
}

main() {
  echo
  cyan "═══════════════════════════════════════════"
  cyan "  terminalcat installer"
  cyan "═══════════════════════════════════════════"
  echo
  cyan "Step 1/6 — detecting package manager"
  detect_pm
  echo
  cyan "Step 2/6 — installing prerequisites"
  check_or_install_curl
  check_or_install_git
  check_or_install_tmux
  check_or_install_build_tools
  check_or_install_node
  check_or_install_pnpm
  check_or_install_cloudflared
  echo
  cyan "Step 3/6 — fetching the source"
  clone_or_update
  echo
  cyan "Step 4/6 — installing deps"
  install_deps
  echo
  cyan "Step 5/6 — Cloudflare Access env config"
  prompt_env
  echo
  cyan "Step 6/6 — service + shims"
  ask_systemd
  ask_tunnel_systemd
  ask_shims
  print_next_steps
}

main "$@"
