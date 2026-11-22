#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 or Debian 12 VM to deploy Specmill: it hardens the VM, then builds the Specmill
# container (dsh/container/run.sh: DSH with dsh-superagent and clean-reviewer) for an unprivileged user to run.
# Why, and the full instructions: dsh/container/README.md.
#
# Run once as your admin user, who must already log in with an SSH key and have sudo:
#   curl -fsSLO https://raw.githubusercontent.com/mrhoody/specmill/<branch>/dsh/container/bootstrap-vm.sh
#   sudo bash bootstrap-vm.sh
#
# What it does:
#   - SSH: key-only login, no root login, only the admin user and the service user may log in.
#   - Firewall: ufw allows only SSH (rate-limited); fail2ban bans repeated SSH failures.
#   - Updates: unattended security upgrades, without automatic reboots unless AUTO_REBOOT_TIME is set.
#   - Docker: rootless, for the service user `dsh`, which has no sudo. The rootful daemon is disabled. Rootless Docker
#     does not edit the host's iptables, so ufw stays authoritative over every port.
#   - Checks the kernel can sandbox the reviewer's shell (Landlock or user namespaces), disk space and memory.
#   - Clones the repository as `dsh` and builds the image. Secrets are never handled here.
#
# Settings (environment variables):
#   SERVICE_USER      the unprivileged user that runs Docker and the service (default: dsh)
#   REPO_URL          repository to clone (default: https://github.com/mrhoody/specmill.git)
#   REPO_BRANCH       branch to check out (default: main)
#   AUTO_REBOOT_TIME  e.g. 04:00 to let unattended-upgrades reboot at that time; empty (default) never reboots
#   SKIP_BUILD=1      do not build the image
set -euo pipefail

SERVICE_USER=${SERVICE_USER:-dsh}
REPO_URL=${REPO_URL:-https://github.com/mrhoody/specmill.git}
REPO_BRANCH=${REPO_BRANCH:-main}
AUTO_REBOOT_TIME=${AUTO_REBOOT_TIME:-}
SKIP_BUILD=${SKIP_BUILD:-}
MIN_FREE_GB=8

step() { printf '\n==> %s\n' "$*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

# --- Preconditions -----------------------------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die 'run with sudo'
ADMIN_USER=${SUDO_USER:-}
[ -n "$ADMIN_USER" ] && [ "$ADMIN_USER" != root ] || die 'run as your admin user with sudo, not as root directly'
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:24.04|debian:12) ;;
  *) die "untested OS $PRETTY_NAME; supported: Ubuntu 24.04, Debian 12" ;;
esac
ADMIN_HOME=$(getent passwd "$ADMIN_USER" | cut -d: -f6)
ADMIN_KEYS="$ADMIN_HOME/.ssh/authorized_keys"
# Password login is about to be disabled: refuse unless the admin user can already log in with a key.
[ -s "$ADMIN_KEYS" ] || die "$ADMIN_KEYS is empty; add your SSH public key first, or you would be locked out"
[ "$SERVICE_USER" != "$ADMIN_USER" ] || die 'SERVICE_USER must differ from the admin user'

# --- Packages and updates ----------------------------------------------------------------------------------------
step 'Updating the system and installing packages'
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q upgrade
apt-get -y -q install ca-certificates curl git jq ufw fail2ban unattended-upgrades \
  uidmap dbus-user-session slirp4netns iptables systemd-container

step 'Enabling unattended security upgrades'
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
if [ -n "$AUTO_REBOOT_TIME" ]; then
  printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "%s";\n' \
    "$AUTO_REBOOT_TIME" > /etc/apt/apt.conf.d/52specmill-reboot
else
  # A reboot would kill a running ticket and the container with it.
  printf 'Unattended-Upgrade::Automatic-Reboot "false";\n' > /etc/apt/apt.conf.d/52specmill-reboot
fi
systemctl enable --now unattended-upgrades >/dev/null

# --- Service user ------------------------------------------------------------------------------------------------
step "Creating the service user $SERVICE_USER (no sudo, SSH key login only)"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$SERVICE_USER"
fi
passwd --lock "$SERVICE_USER" >/dev/null
for group in sudo adm docker; do
  if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx "$group"; then gpasswd -d "$SERVICE_USER" "$group" >/dev/null; fi
done
SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
SERVICE_UID=$(id -u "$SERVICE_USER")
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME/.ssh"
install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ADMIN_KEYS" "$SERVICE_HOME/.ssh/authorized_keys"
# Rootless Docker maps container users into these subordinate id ranges.
grep -q "^$SERVICE_USER:" /etc/subuid || usermod --add-subuids 100000-165535 "$SERVICE_USER"
grep -q "^$SERVICE_USER:" /etc/subgid || usermod --add-subgids 100000-165535 "$SERVICE_USER"

# --- SSH ---------------------------------------------------------------------------------------------------------
step 'Hardening SSH'
cat > /etc/ssh/sshd_config.d/10-specmill-hardening.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers $ADMIN_USER $SERVICE_USER
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
# The panel is reached through a local tunnel (ssh -L 3082:127.0.0.1:3082); nothing else needs forwarding.
AllowAgentForwarding no
AllowStreamLocalForwarding no
GatewayPorts no
EOF
# Ubuntu 24.04 starts sshd per connection (socket activation), so its privilege separation directory may not exist yet.
install -d -m 0755 /run/sshd
sshd -t || { rm -f /etc/ssh/sshd_config.d/10-specmill-hardening.conf; die 'sshd rejected the config; it was removed'; }
# Some images ship a drop-in that turns password login back on; files are read in order and the first value wins.
for file in /etc/ssh/sshd_config.d/*.conf; do
  [ "$file" = /etc/ssh/sshd_config.d/10-specmill-hardening.conf ] && continue
  if grep -qiE '^\s*PasswordAuthentication\s+yes' "$file"; then
    sed -i -E 's/^\s*PasswordAuthentication\s+yes/# &  (disabled by bootstrap-vm.sh)/I' "$file"
  fi
done
sshd -t
# A running daemon must reload; a socket-activated one reads the config afresh for every new connection.
for unit in ssh.service sshd.service; do
  if systemctl is-active --quiet "$unit"; then systemctl reload "$unit"; break; fi
done

# --- Firewall and brute-force protection -------------------------------------------------------------------------
step 'Configuring the firewall: SSH only'
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw limit OpenSSH >/dev/null
ufw --force enable >/dev/null

step 'Configuring fail2ban for SSH'
cat > /etc/fail2ban/jail.d/specmill-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

# --- Rootless Docker ---------------------------------------------------------------------------------------------
step 'Installing Docker Engine from Docker'\''s repository'
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -q
apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-ce-rootless-extras

step 'Disabling the rootful Docker daemon'
systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true
rm -f /var/run/docker.sock

# Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor; rootlesskit needs a profile that allows them.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
  step 'Allowing user namespaces for rootlesskit (AppArmor)'
  cat > /etc/apparmor.d/usr.bin.rootlesskit <<'EOF'
abi <abi/4.0>,
include <tunables/global>

/usr/bin/rootlesskit flags=(unconfined) {
  userns,

  include if exists <local/usr.bin.rootlesskit>
}
EOF
  apparmor_parser -r /etc/apparmor.d/usr.bin.rootlesskit
fi

step "Setting up rootless Docker for $SERVICE_USER"
# Lingering keeps the user's systemd manager, and so its Docker daemon and container, running after logout.
loginctl enable-linger "$SERVICE_USER"
systemctl start "user@$SERVICE_UID.service"
as_service() {
  sudo -u "$SERVICE_USER" -H env XDG_RUNTIME_DIR="/run/user/$SERVICE_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SERVICE_UID/bus" "$@"
}
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SERVICE_HOME/.config" "$SERVICE_HOME/.config/docker"
cat > "$SERVICE_HOME/.config/docker/daemon.json" <<'EOF'
{
  "no-new-privileges": true,
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/.config/docker/daemon.json"
as_service dockerd-rootless-setuptool.sh install --force >/dev/null
as_service systemctl --user enable --now docker.service >/dev/null
as_service systemctl --user restart docker.service
grep -q 'DOCKER_HOST=' "$SERVICE_HOME/.bashrc" ||
  printf '\n# Rootless Docker (bootstrap-vm.sh)\nexport DOCKER_HOST=unix:///run/user/%s/docker.sock\n' "$SERVICE_UID" >> "$SERVICE_HOME/.bashrc"
as_service env DOCKER_HOST="unix:///run/user/$SERVICE_UID/docker.sock" docker info --format '{{.SecurityOptions}}' |
  grep -q rootless || die 'Docker is not running rootless'

# --- Capacity and sandbox checks ---------------------------------------------------------------------------------
step 'Checking the kernel sandbox, disk and memory'
if grep -qw landlock /sys/kernel/security/lsm 2>/dev/null; then
  echo 'Landlock: enabled (the reviewer'\''s shell is sandboxed with it)'
else
  die 'Landlock is not enabled in this kernel, so DSH cannot sandbox the reviewer'\''s shell inside the container'
fi
free_gb=$(df --output=avail -BG "$SERVICE_HOME" | tail -1 | tr -dc 0-9)
[ "$free_gb" -ge "$MIN_FREE_GB" ] || die "only ${free_gb}G free in $SERVICE_HOME; the image and builds need ${MIN_FREE_GB}G"
mem_mb=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 4000 ] && ! swapon --show | grep -q .; then
  echo "Only ${mem_mb}M of memory and no swap: adding a 2G swap file for the builds"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Repository and image ----------------------------------------------------------------------------------------
step "Cloning $REPO_URL ($REPO_BRANCH) as $SERVICE_USER"
if [ -d "$SERVICE_HOME/specmill/.git" ]; then
  as_service git -C "$SERVICE_HOME/specmill" fetch --quiet origin "$REPO_BRANCH"
  as_service git -C "$SERVICE_HOME/specmill" checkout --quiet -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
else
  as_service git clone --quiet --branch "$REPO_BRANCH" "$REPO_URL" "$SERVICE_HOME/specmill"
fi

if [ -z "$SKIP_BUILD" ]; then
  step 'Building the image (several minutes)'
  as_service env DOCKER_HOST="unix:///run/user/$SERVICE_UID/docker.sock" \
    docker build --quiet -f "$SERVICE_HOME/specmill/dsh/container/Dockerfile" -t specmill-superagent "$SERVICE_HOME/specmill" >/dev/null
fi

# --- Final check -------------------------------------------------------------------------------------------------
step 'Listening sockets on public addresses (expect only SSH)'
ss -H -tln | awk '{print $4}' | grep -v -E '^(127\.|\[::1\]|::1)' || true

cat <<EOF

Done. Next, from your own machine:

  ssh -L 3082:127.0.0.1:3082 $SERVICE_USER@<this vm>
  export DEEPSEEK_API_KEY=...  AGENT_GH_TOKEN=...  SUPERAGENT_REPO=owner/name
  DETACH=1 ~/specmill/dsh/container/run.sh
  docker logs specmill-superagent | grep token=     # the panel URL; open it while the tunnel is up

$SERVICE_USER has no sudo. Administer the VM as $ADMIN_USER.
EOF
