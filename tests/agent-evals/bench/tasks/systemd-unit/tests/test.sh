#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import configparser, shlex, sys
p = configparser.ConfigParser(strict=False, interpolation=None)
p.optionxform = str
try:
    if not p.read("deploy/orders.service"):
        sys.exit("deploy/orders.service missing")
except configparser.Error as e:
    sys.exit(f"unparseable unit: {e}")
def get(section, key):
    return p.get(section, key, fallback="").strip()
errors = []
def need(cond, msg):
    if not cond: errors.append(msg)
need(p.has_section("Unit") and p.has_section("Service") and p.has_section("Install"), "needs [Unit], [Service], [Install]")
need("network-online.target" in get("Unit", "After").split(), "After= must include network-online.target")
need("network-online.target" in get("Unit", "Wants").split(), "Wants= must include network-online.target")
need(shlex.split(get("Service", "ExecStart")) == ["/opt/orders/bin/server", "--port", "8080"], "wrong ExecStart")
need(get("Service", "User") == "orders" and get("Service", "Group") == "orders", "User/Group must be orders")
need(get("Service", "WorkingDirectory") == "/opt/orders", "wrong WorkingDirectory")
need(get("Service", "EnvironmentFile").lstrip("-") == "/etc/orders/env", "wrong EnvironmentFile")
need(get("Service", "Restart") == "always", "Restart must be always")
need(get("Service", "RestartSec").rstrip("s") == "5", "RestartSec must be 5")
need("multi-user.target" in get("Install", "WantedBy").split(), "WantedBy must include multi-user.target")
if errors:
    sys.exit("\n".join(errors))
print("unit ok")
PY
