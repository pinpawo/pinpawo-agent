#!/usr/bin/env bash
set -euo pipefail
cat > deploy/orders.service <<'UNIT'
[Unit]
Description=Orders API
Wants=network-online.target
After=network-online.target

[Service]
User=orders
Group=orders
WorkingDirectory=/opt/orders
EnvironmentFile=/etc/orders/env
ExecStart=/opt/orders/bin/server --port 8080
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
