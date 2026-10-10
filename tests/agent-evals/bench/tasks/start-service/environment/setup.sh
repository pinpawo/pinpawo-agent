#!/usr/bin/env bash
set -euo pipefail
cp -R "$TASK_DIR/environment/files/." .
chmod +x start.sh
