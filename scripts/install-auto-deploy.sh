#!/bin/bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo '请使用 sudo bash 执行'; exit 1; fi
ref="${1:-}"
if ! [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then echo '请传入安装版本的完整提交SHA'; exit 1; fi
for tool in python3 curl docker systemctl; do command -v "$tool" >/dev/null; done
test -f /opt/hengzi-app/server.js
test -f /opt/hengzi-app/data/hengzi.db
docker inspect hengzi-fm >/dev/null
install -d -m 700 /opt/hengzi-deploy /opt/hengzi-backups
tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT
curl --fail --silent --show-error --location --retry 2 --proto '=https' \
 "https://raw.githubusercontent.com/jiaqiang-coder/finance-management/${ref}/scripts/auto-deploy.py" -o "$tmpfile"
python3 - "$tmpfile" <<'PY'
import sys
from pathlib import Path
compile(Path(sys.argv[1]).read_text(), 'auto-deploy.py', 'exec')
PY
install -m 700 "$tmpfile" /opt/hengzi-deploy/auto-deploy.py
cat > /etc/systemd/system/hengzi-auto-deploy.service <<'UNIT'
[Unit]
Description=Update only Hengzi from successful GitHub main CI
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/hengzi-deploy/auto-deploy.py
TimeoutStartSec=600
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/hengzi-app /opt/hengzi-deploy /opt/hengzi-backups
UNIT
cat > /etc/systemd/system/hengzi-auto-deploy.timer <<'UNIT'
[Unit]
Description=Check Hengzi GitHub updates every five minutes
[Timer]
OnCalendar=*:0/5
RandomizedDelaySec=20
Persistent=true
Unit=hengzi-auto-deploy.service
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now hengzi-auto-deploy.timer
# First check runs in the background, so installer does not wait for a network request.
systemctl start --no-block hengzi-auto-deploy.service
echo '自动部署定时器已启用。仅在 main 当前提交的 CI 成功后更新衡资。'
systemctl list-timers hengzi-auto-deploy.timer --no-pager
