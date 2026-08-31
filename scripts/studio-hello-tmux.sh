#!/usr/bin/env bash

set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
session_name="${PINPAWO_STUDIO_TMUX_SESSION:-pinpawo-studio}"
pet_port=3210
reset_session=false
attach_session=true

usage() {
  cat <<'EOF'
Usage: npm run studio:hello:tmux -- [--reset] [--detached]

Create one tmux session for the Studio Hello World:
  host  - starts Studio Hello World when the Pet port is not already listening
  pets  - tiled planner, executor, reviewer, and wiki Pet TUIs

Options:
  --reset      replace an existing tmux session
  --detached   create the session without attaching
  -h, --help   show this help

Environment:
  PINPAWO_STUDIO_TMUX_SESSION  tmux session name (default: pinpawo-studio)
EOF
}

while (($# > 0)); do
  case "$1" in
    --reset)
      reset_session=true
      ;;
    --detached)
      attach_session=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if ! command -v tmux >/dev/null 2>&1; then
  echo 'tmux is required. Install it with: brew install tmux' >&2
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  echo 'lsof is required to detect the Studio Pet listener.' >&2
  exit 1
fi

session_exists() {
  tmux has-session -t "$session_name" 2>/dev/null
}

pet_listener_ready() {
  lsof -nP -iTCP:"$pet_port" -sTCP:LISTEN >/dev/null 2>&1
}

attach_or_report() {
  if [[ "$attach_session" == true ]]; then
    if [[ -n "${TMUX:-}" ]]; then
      exec tmux switch-client -t "$session_name"
    fi
    exec tmux attach-session -t "$session_name"
  fi
  echo "Studio tmux session ready: $session_name"
  echo "Attach with: tmux attach-session -t $session_name"
}

reset_stops_host=false
if [[ "$reset_session" == true ]] && session_exists; then
  if tmux list-windows -t "$session_name" -F '#{window_name}' | grep -Fxq host; then
    reset_stops_host=true
  fi
  tmux kill-session -t "$session_name"
  if [[ "$reset_stops_host" == true ]]; then
    for _attempt in {1..80}; do
      if ! pet_listener_ready; then
        break
      fi
      sleep 0.25
    done
    if pet_listener_ready; then
      echo "The previous Studio host is still listening on port $pet_port." >&2
      exit 1
    fi
  fi
fi

if session_exists; then
  attach_or_report
  exit 0
fi

printf -v workspace_root_q '%q' "$workspace_root"
printf -v pet_port_q '%q' "$pet_port"

host_started=false
if ! pet_listener_ready; then
  host_started=true
  tmux new-session -d -s "$session_name" -n host \
    "cd $workspace_root_q && exec npm run studio:hello"

  ready=false
  for _attempt in {1..600}; do
    if pet_listener_ready; then
      ready=true
      break
    fi
    if ! session_exists; then
      echo 'Studio tmux session exited before the Pet listener became ready.' >&2
      exit 1
    fi
    sleep 0.25
  done
  if [[ "$ready" != true ]]; then
    echo "Studio Pet listener did not become ready on port $pet_port within 150 seconds." >&2
    echo "Inspect the host window with: tmux attach-session -t $session_name" >&2
    exit 1
  fi
fi

pet_tui_command() {
  local pet_id="$1"
  printf 'cd %s && exec npm run tui -w pinpawo -- --pet-port %s --pet-id %q' \
    "$workspace_root_q" "$pet_port_q" "$pet_id"
}

if [[ "$host_started" == true ]]; then
  planner_pane="$(tmux new-window -d -P -F '#{pane_id}' \
    -t "$session_name" -n pets "$(pet_tui_command planner)")"
else
  planner_pane="$(tmux new-session -d -P -F '#{pane_id}' \
    -s "$session_name" -n pets "$(pet_tui_command planner)")"
fi

executor_pane="$(tmux split-window -d -h -P -F '#{pane_id}' \
  -t "$session_name:pets" "$(pet_tui_command executor)")"
reviewer_pane="$(tmux split-window -d -v -P -F '#{pane_id}' \
  -t "$session_name:pets" "$(pet_tui_command reviewer)")"
wiki_pane="$(tmux split-window -d -v -P -F '#{pane_id}' \
  -t "$session_name:pets" "$(pet_tui_command wiki)")"
tmux select-layout -t "$session_name:pets" tiled >/dev/null
tmux set-option -t "$session_name" mouse on
tmux set-window-option -t "$session_name:pets" remain-on-exit on
tmux select-pane -t "$planner_pane" -T Planner
tmux select-pane -t "$executor_pane" -T Executor
tmux select-pane -t "$reviewer_pane" -T Reviewer
tmux select-pane -t "$wiki_pane" -T Wiki
tmux select-window -t "$session_name:pets"
tmux select-pane -t "$planner_pane"

attach_or_report
