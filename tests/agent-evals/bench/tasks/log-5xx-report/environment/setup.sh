#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import random
random.seed(7)
ips = [f"10.0.{a}.{b}" for a in range(3) for b in range(1, 6)]
paths = ["/", "/api/orders", "/api/users", "/health", "/static/app.js"]
statuses = [200] * 12 + [301, 304, 404, 500, 502, 503]
with open("access.log", "w") as f:
    for i in range(2000):
        ip = random.choice(ips)
        st = random.choice(statuses)
        f.write(f'{ip} - - [10/Oct/2026:13:{i % 60:02d}:{i % 60:02d} +0000] '
                f'"GET {random.choice(paths)} HTTP/1.1" {st} {random.randint(100, 9000)} '
                f'"-" "curl/8.5.0"\n')
PY
