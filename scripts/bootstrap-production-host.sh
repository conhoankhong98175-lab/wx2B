#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

hostnamectl set-hostname diangao-prod
timedatectl set-timezone Asia/Shanghai

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  fail2ban \
  git \
  gnupg \
  unattended-upgrades \
  ufw

install -m 0755 -d /etc/apt/keyrings
docker_apt_base=${DOCKER_APT_BASE:-https://mirrors.cloud.tencent.com/docker-ce}
if ! gpg --batch --quiet --show-keys /etc/apt/keyrings/docker.gpg >/dev/null 2>&1; then
  rm -f /etc/apt/keyrings/docker.gpg
  docker_key=$(mktemp)
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 10 \
    "${docker_apt_base}/linux/ubuntu/gpg" \
    -o "${docker_key}"
  gpg --batch --dearmor --output /etc/apt/keyrings/docker.gpg "${docker_key}"
  rm -f "${docker_key}"
fi
chmod a+r /etc/apt/keyrings/docker.gpg

# shellcheck disable=SC1091
. /etc/os-release
printf '%s\n' \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] ${docker_apt_base}/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y --no-install-recommends \
  containerd.io \
  docker-buildx-plugin \
  docker-ce \
  docker-ce-cli \
  docker-compose-plugin

python3 <<'PY'
import json
from pathlib import Path

path = Path('/etc/docker/daemon.json')
config = json.loads(path.read_text()) if path.exists() else {}
mirrors = config.setdefault('registry-mirrors', [])
mirror = 'https://mirror.ccs.tencentyun.com'
if mirror not in mirrors:
    mirrors.append(mirror)
path.write_text(json.dumps(config, indent=2) + '\n')
PY

systemctl enable docker
systemctl restart docker
usermod -aG docker ubuntu

install -d -o root -g docker -m 2770 \
  /opt/diangao \
  /opt/diangao/releases \
  /opt/diangao/shared \
  /opt/diangao/shared/backups

rm -f /etc/ssh/sshd_config.d/99-diagao.conf
cat > /etc/ssh/sshd_config.d/01-diagao.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF
sshd -t
systemctl reload ssh

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

docker --version
docker compose version
ufw status verbose
systemctl --no-pager --full status docker fail2ban | sed -n '1,24p'
