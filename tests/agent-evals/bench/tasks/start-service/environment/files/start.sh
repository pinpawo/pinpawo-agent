#!/usr/bin/env bash
cd "$(dirname "$0")"
PROT=18080 nohup python3 app.py > app.log 2>&1 &
