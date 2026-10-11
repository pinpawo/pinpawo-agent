#!/usr/bin/env bash
set -euo pipefail
# test.js must be the original one.
cmp -s test.js "$TASK_DIR/environment/files/test.js" || { echo "test.js was modified"; exit 1; }
node test.js
