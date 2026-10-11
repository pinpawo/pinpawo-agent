#!/usr/bin/env bash
set -euo pipefail
awk '$9 ~ /^5[0-9][0-9]$/ { c[$1]++ } END { for (ip in c) print ip, c[ip] }' access.log \
  | sort -k2,2nr -k1,1 | head -3 > report.txt
