#!/bin/sh
# rebotarm-health.sh — check the running reBotArm server (read-only).
# Exit 0 when /api/health answers; non-zero otherwise. Never touches CAN.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BASE=$(dirname "$SCRIPT_DIR")

ENV_FILE="$BASE/shared/env/rebotarm.env"
HOST=127.0.0.1
PORT=8000
if [ -f "$ENV_FILE" ]; then
    # Read only host/port without exporting anything else.
    HOST=$(sed -n 's/^REBOT_HOST=\(.*\)$/\1/p' "$ENV_FILE" | tail -n 1)
    PORT=$(sed -n 's/^REBOT_PORT=\(.*\)$/\1/p' "$ENV_FILE" | tail -n 1)
    HOST=${HOST:-127.0.0.1}
    PORT=${PORT:-8000}
fi

URL="http://$HOST:$PORT/api/health"
if ! command -v curl >/dev/null 2>&1; then
    echo "ERROR: curl not found." >&2
    exit 2
fi

BODY=$(curl -fsS --max-time 5 "$URL") || {
    echo "UNHEALTHY: no answer from $URL" >&2
    exit 1
}
echo "$BODY"

# Fail closed on surprising adapter reports for a smoke deployment: warn if
# the live adapter is not what the env file declares.
DECLARED=$(sed -n 's/^REBOT_ADAPTER=\(.*\)$/\1/p' "$ENV_FILE" 2>/dev/null | tail -n 1)
if [ -n "$DECLARED" ]; then
    case "$BODY" in
        *"\"adapter\": \"$DECLARED\""*|*"\"adapter\":\"$DECLARED\""*) : ;;
        *)
            echo "WARNING: live adapter differs from REBOT_ADAPTER=$DECLARED" >&2
            exit 1
            ;;
    esac
fi
echo "HEALTHY"
