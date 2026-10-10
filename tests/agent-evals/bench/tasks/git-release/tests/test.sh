#!/usr/bin/env bash
set -euo pipefail
fail() { echo "$1"; exit 1; }
git rev-parse -q --verify refs/heads/release/1.2.0 >/dev/null || fail "branch release/1.2.0 missing"
[ "$(git log -1 --format=%s main)" = "fix: readme" ] || fail "main moved"
[ "$(git rev-parse release/1.2.0~1)" = "$(git rev-parse main)" ] || fail "release must be one commit on top of main"
[ "$(git log -1 --format=%s release/1.2.0)" = "chore: release 1.2.0" ] || fail "wrong commit message"
[ "$(git diff --name-only main release/1.2.0)" = "package.json" ] || fail "commit must change only package.json"
git show release/1.2.0:package.json | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    if (JSON.parse(s).version !== "1.2.0") { console.log("version not 1.2.0"); process.exit(1); }
  });'
[ "$(git cat-file -t v1.2.0)" = "tag" ] || fail "v1.2.0 must be an annotated tag"
[ "$(git rev-parse 'v1.2.0^{commit}')" = "$(git rev-parse release/1.2.0)" ] || fail "tag points elsewhere"
echo "release ok"
