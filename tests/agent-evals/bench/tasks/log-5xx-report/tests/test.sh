#!/usr/bin/env bash
set -euo pipefail
[ -f report.txt ] || { echo "report.txt missing"; exit 1; }
expected=$(awk '$9 ~ /^5[0-9][0-9]$/ { c[$1]++ } END { for (ip in c) print ip, c[ip] }' access.log \
  | sort -k2,2nr -k1,1 | head -3)
actual=$(sed -e 's/[[:space:]]*$//' -e '/^$/d' report.txt)
if [ "$expected" != "$actual" ]; then
  printf 'expected:\n%s\nactual:\n%s\n' "$expected" "$actual"
  exit 1
fi
echo "report matches"
