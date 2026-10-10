#!/usr/bin/env bash
set -euo pipefail
cleanup() { [ -f app.pid ] && kill "$(cat app.pid)" 2>/dev/null || true; }
trap cleanup EXIT
cmp -s app.py "$TASK_DIR/environment/files/app.py" || { echo "app.py was modified"; exit 1; }
[ -f app.pid ] || { echo "app.pid missing"; exit 1; }
kill -0 "$(cat app.pid)" 2>/dev/null || { echo "pid in app.pid is not running"; exit 1; }
python3 - <<'PY'
import sys, time, urllib.request
for _ in range(20):
    try:
        body = urllib.request.urlopen("http://127.0.0.1:18080/health", timeout=2).read().decode()
        if body.strip() == "ok":
            print("health ok"); sys.exit(0)
        sys.exit(f"unexpected body: {body!r}")
    except Exception as e:
        err = e
        time.sleep(0.5)
sys.exit(f"service not healthy: {err}")
PY
