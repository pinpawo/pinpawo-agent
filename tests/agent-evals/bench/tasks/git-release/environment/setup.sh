#!/usr/bin/env bash
set -euo pipefail
git init -q -b main .
git config user.email bench@pinpawo.local
git config user.name bench
# The agent keeps its runtime state in .pinpawo/; it is not part of the task.
echo '.pinpawo/' >> .git/info/exclude
printf '{\n  "name": "demo",\n  "version": "1.1.3"\n}\n' > package.json
echo "# demo" > README.md
git add . && git commit -q -m "feat: initial"
echo "fix" >> README.md && git commit -q -am "fix: readme"
