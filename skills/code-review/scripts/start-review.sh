#!/bin/bash
PROJECT_ROOT="${1:-$(pwd)}"
SESSION="pi-review"

# Kill existing session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Start pi in new session
tmux new-session -d -s "$SESSION" -c "$PROJECT_ROOT" 'pi'
echo "pi-review session started in $PROJECT_ROOT"
