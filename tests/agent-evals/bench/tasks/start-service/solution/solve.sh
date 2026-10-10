#!/usr/bin/env bash
set -euo pipefail
cat > start.sh <<'SH'
#!/usr/bin/env bash
cd "$(dirname "$0")"
set -a; . ./app.env; set +a
PORT=18080 nohup python3 app.py > app.log 2>&1 &
echo $! > app.pid
SH
chmod +x start.sh
./start.sh
sleep 1
