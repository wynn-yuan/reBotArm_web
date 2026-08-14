#!/bin/sh
# rebotarm-start.sh — start the reBotArm server in user space (no sudo).
#
# Layout assumption (created by install_release.sh):
#   $BASE/current        -> releases/<id>   (server/, web/dist/, scripts/)
#   $BASE/shared/env/rebotarm.env           (chmod 600)
#   $BASE/shared/logs/                      (server.out, rebotarm.pid)
#   $BASE/shared/venv/bin/python            (Python 3.10 venv)
#
# Static hosting: REBOT_WEB_DIST_DIR always follows the CURRENT release.
# set -eu: fail closed on any unexpected error.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BASE=$(dirname "$SCRIPT_DIR")

ENV_FILE="$BASE/shared/env/rebotarm.env"
LOG_DIR="$BASE/shared/logs"
AGING_LOG_DIR="$BASE/log"
TRAJECTORY_DIR="$BASE/Trajectory"
PID_FILE="$LOG_DIR/rebotarm.pid"
OUT_LOG="$LOG_DIR/server.out"

if [ ! -d "$BASE/current" ]; then
    echo "ERROR: $BASE/current does not exist; run install_release.sh first." >&2
    exit 1
fi
if [ ! -x "$BASE/shared/venv/bin/python" ]; then
    echo "ERROR: $BASE/shared/venv/bin/python missing; run install_release.sh first." >&2
    exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE missing (fail closed)." >&2
    exit 1
fi

# Already running?
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "ERROR: already running (pid $OLD_PID). Use rebotarm-stop.sh first." >&2
        exit 1
    fi
    rm -f "$PID_FILE"
fi

mkdir -p "$LOG_DIR" "$AGING_LOG_DIR" "$TRAJECTORY_DIR"
chmod 700 "$AGING_LOG_DIR"
chmod 700 "$TRAJECTORY_DIR"

# Load operator configuration (adapter/channel/gates/...).
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Static hosting always serves the CURRENT release's pre-built web UI.
REBOT_WEB_DIST_DIR="$BASE/current/web/dist"
export REBOT_WEB_DIST_DIR
# Aging telemetry always uses the deployment-owned fixed path. The UI cannot
# select or create another root.
REBOT_AGING_LOG_ROOT="$AGING_LOG_DIR"
export REBOT_AGING_LOG_ROOT
# Backend action library (Trajectory) lives side-by-side with the aging log.
# The UI reads/writes actions only through this deployment-owned directory.
REBOT_TRAJECTORY_DIR="$TRAJECTORY_DIR"
export REBOT_TRAJECTORY_DIR
# Gravity compensation URDF model: always points to the CURRENT release's
# pre-built web dist (same as REBOT_WEB_DIST_DIR).  The operator can override
# via REBOT_URDF_PATH in the env file.
if [ -z "${REBOT_URDF_PATH:-}" ]; then
    REBOT_URDF_PATH="$BASE/current/web/dist/robots/rebot-b601-rs/model.urdf"
    export REBOT_URDF_PATH
fi

PORT="${REBOT_PORT:-8000}"
HOST="${REBOT_HOST:-127.0.0.1}"

echo "starting rebot-server (adapter=${REBOT_ADAPTER:-?}, channel=${REBOT_CAN_CHANNEL:-?}, host=$HOST, port=$PORT)"
nohup "$BASE/shared/venv/bin/python" -m rebot_server >>"$OUT_LOG" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

# Wait for the health endpoint (fail closed: report loudly, keep the process
# for inspection; use rebotarm-stop.sh to clean up).
i=0
while [ "$i" -lt 30 ]; do
    if curl -fsS "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
        echo "healthy (pid $PID)"
        curl -fsS "http://$HOST:$PORT/api/health" || true
        echo
        exit 0
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "ERROR: server process exited during startup; last log lines:" >&2
        tail -n 25 "$OUT_LOG" >&2 || true
        rm -f "$PID_FILE"
        exit 1
    fi
    i=$((i + 1))
    sleep 0.5
done

echo "ERROR: not healthy after 15 s (pid $PID still running); last log lines:" >&2
tail -n 25 "$OUT_LOG" >&2 || true
exit 1
