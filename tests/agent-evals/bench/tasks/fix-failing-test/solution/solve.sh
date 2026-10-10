#!/usr/bin/env bash
set -euo pipefail
sed -i.bak 's|price \* percent;|price * percent / 100;|' src/price.js && rm -f src/price.js.bak
