#!/usr/bin/env bash
# Build this checkout and pack the tarballs the Harbor adapter installs into
# each task container. Output: tests/agent-evals/harbor/dist/*.tgz
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
out="$here/dist"
workspaces=(
  @pinpawo/agent-contracts
  @pinpawo/agent-session
  @pinpawo/pet-agent
  @pinpawo-toolkit/browser
  pinpawo
)
cd "$root"
for ws in "${workspaces[@]}"; do
  npm run build -w "$ws" >/dev/null
done
rm -rf "$out" && mkdir -p "$out"
for ws in "${workspaces[@]}"; do
  npm pack -w "$ws" --pack-destination "$out" >/dev/null 2>&1
done
ls -1 "$out"
