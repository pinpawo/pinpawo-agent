#!/usr/bin/env bash
set -euo pipefail
git checkout -q -b release/1.2.0 main
sed -i.bak 's/"version": "1.1.3"/"version": "1.2.0"/' package.json && rm -f package.json.bak
git commit -q -am "chore: release 1.2.0"
git tag -a v1.2.0 -m "v1.2.0"
