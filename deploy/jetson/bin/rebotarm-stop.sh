#!/bin/sh
# rebotarm-stop.sh — stop the reBotArm server (user space, no sudo).
# Graceful SIGTERM first; SIGKILL only as a last resort after 10 s.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BASE=$(dirname "$SCRIPT_DIR")

PID_FILE="$BASE/shared/logs/rebotarm.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "not running (no pid file)."
    exit 0
fi

PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
if [ -z "$PID" ]; then
    echo "empty pid file; removing."
    rm -f "$PID_FILE"
    exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
    echo "stale pid file (process $PID not running); removing."
    rm -f "$PID_FILE"
    exit 0
fi

echo "stopping rebot-server (pid $PID) with SIGTERM..."
kill -TERM "$PID"

i=0
while [ "$i" -lt 20 ]; do
    if ! kill -0 "$PID" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "stopped."
        exit 0
    fi
    i=$((i + 1))
    sleep 0.5
done

echo "WARNING: still running after 10 s; sending SIGKILL." >&2
kill -KILL "$PID" 2>/dev/null || true
sleep 1
if kill -0 "$PID" 2>/dev/null; then
    echo "ERROR: process $PID could not be stopped." >&2
    exit 1
fi
rm -f "$PID_FILE"
echo "stopped (forced)."
