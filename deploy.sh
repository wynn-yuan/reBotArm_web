#!/bin/sh
# reBotArm Web one-click deployment for a Jetson that already contains source.
# This script builds and deploys the web service. It never configures CAN,
# scans motors, enables motors, homes the arm, or starts zero-torque/aging.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT="$SCRIPT_DIR"
BASE="${REBOTARM_BASE:-/home/revolute1/rebotarm-web}"
RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)-source"
RUN_TESTS=1
VERIFY_DIR=""

usage() {
    echo "usage: sh deploy.sh [--release-id ID] [--base DIR] [--skip-tests]"
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

need() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

cleanup() {
    if [ -n "$VERIFY_DIR" ] && [ -d "$VERIFY_DIR" ]; then
        rm -rf "$VERIFY_DIR"
    fi
}
trap cleanup EXIT HUP INT TERM

while [ "$#" -gt 0 ]; do
    case "$1" in
        --release-id)
            [ "$#" -ge 2 ] || die "--release-id requires a value"
            RELEASE_ID=$2
            shift 2
            ;;
        --base)
            [ "$#" -ge 2 ] || die "--base requires a value"
            BASE=$2
            shift 2
            ;;
        --skip-tests)
            RUN_TESTS=0
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            die "unknown argument: $1"
            ;;
    esac
done

case "$RELEASE_ID" in
    ""|*/*|*..*) die "unsafe release id: $RELEASE_ID" ;;
esac
case "$BASE" in
    /*) : ;;
    *) die "--base must be an absolute path" ;;
esac

[ "$(id -u)" -ne 0 ] || die "run as the deploy user, not root"
need node
need npm
need python3.10
need tar
need curl
need sha256sum

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' \
    || die "Node.js must be >=20.19 or >=22.12"
[ -f "$REPO_ROOT/package-lock.json" ] || die "package-lock.json missing"
[ -f "$REPO_ROOT/deploy/jetson/make_release.sh" ] || die "release builder missing"
[ -f "$REPO_ROOT/deploy/jetson/install_release.sh" ] || die "release installer missing"

echo "[1/6] Installing locked frontend dependencies"
cd "$REPO_ROOT"
npm ci

echo "[2/6] Checking and building frontend"
npm run type-check
if [ "$RUN_TESTS" -eq 1 ]; then
    npm run test --workspace @rebotarm/web
fi
npm run build

if [ "$RUN_TESTS" -eq 1 ]; then
    echo "[3/6] Running isolated backend tests (no CAN or hardware calls)"
    VERIFY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/rebotarm-verify.XXXXXX")
    python3.10 -m venv "$VERIFY_DIR"
    "$VERIFY_DIR/bin/python" -m pip install --disable-pip-version-check --quiet -e "$REPO_ROOT/apps/server[dev]"
    "$VERIFY_DIR/bin/python" -m pytest -q "$REPO_ROOT/apps/server/tests"
    rm -rf "$VERIFY_DIR"
    VERIFY_DIR=""
else
    echo "[3/6] Backend tests skipped by operator"
fi

echo "[4/6] Building release $RELEASE_ID"
sh "$REPO_ROOT/deploy/jetson/make_release.sh" "$RELEASE_ID"
TARBALL="$REPO_ROOT/deploy/jetson/out/rebotarm-release-$RELEASE_ID.tar.gz"
[ -f "$TARBALL" ] || die "release tarball was not created"
sha256sum "$TARBALL"

PID_FILE="$BASE/shared/logs/rebotarm.pid"
WAS_RUNNING=0
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        WAS_RUNNING=1
    fi
fi

# Fail closed before stopping: shutdown may perform controlled cleanup when a
# hardware mode is active, so deployment refuses to interrupt those modes.
if [ "$WAS_RUNNING" -eq 1 ]; then
    "$BASE/bin/rebotarm-health.sh"
    AGING_JSON=$(curl -fsS --max-time 5 http://127.0.0.1:8000/api/aging/status)
    ZERO_JSON=$(curl -fsS --max-time 5 http://127.0.0.1:8000/api/robot/zero-torque/status)
    python3.10 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("status") == "inactive" else 1)' "$AGING_JSON" \
        || die "aging status is not inactive; resolve it from the UI before deployment"
    python3.10 -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]).get("status") == "inactive" else 1)' "$ZERO_JSON" \
        || die "zero-torque status is not inactive; resolve it from the UI before deployment"
fi

PREVIOUS=$(readlink "$BASE/current" 2>/dev/null || true)

restart_previous() {
    [ -n "$PREVIOUS" ] || return 1
    PREVIOUS_DIR="$BASE/$PREVIOUS"
    [ -f "$PREVIOUS_DIR/VERSION" ] || return 1
    "$BASE/bin/rebotarm-stop.sh" >/dev/null 2>&1 || true
    "$BASE/shared/venv/bin/python" -m pip install --disable-pip-version-check --quiet "$PREVIOUS_DIR/server"
    install -m 755 "$PREVIOUS_DIR/scripts/rebotarm-start.sh" "$BASE/bin/rebotarm-start.sh"
    install -m 755 "$PREVIOUS_DIR/scripts/rebotarm-stop.sh" "$BASE/bin/rebotarm-stop.sh"
    install -m 755 "$PREVIOUS_DIR/scripts/rebotarm-health.sh" "$BASE/bin/rebotarm-health.sh"
    ln -sfn "$PREVIOUS" "$BASE/current.new"
    mv -Tf "$BASE/current.new" "$BASE/current"
    "$BASE/bin/rebotarm-start.sh"
}

echo "[5/6] Installing and activating release"
if [ "$WAS_RUNNING" -eq 1 ]; then
    "$BASE/bin/rebotarm-stop.sh"
fi
if ! REBOTARM_BASE="$BASE" sh "$REPO_ROOT/deploy/jetson/install_release.sh" "$TARBALL"; then
    echo "installation failed; attempting to restore the previous service" >&2
    restart_previous || true
    exit 1
fi

# Existing operator configuration is preserved by install_release.sh. Ensure
# only the confirmed aging capability gate is present, with a reversible copy.
ENV_FILE="$BASE/shared/env/rebotarm.env"
ENV_BACKUP="$ENV_FILE.before-$RELEASE_ID"
cp "$ENV_FILE" "$ENV_BACKUP"
ENV_TMP=$(mktemp "$BASE/shared/env/rebotarm.env.XXXXXX")
awk '
    BEGIN { found=0 }
    /^REBOT_ALLOW_AGING_WRITE=/ { print "REBOT_ALLOW_AGING_WRITE=1"; found=1; next }
    { print }
    END { if (!found) print "REBOT_ALLOW_AGING_WRITE=1" }
' "$ENV_FILE" >"$ENV_TMP"
chmod 600 "$ENV_TMP"
mv -f "$ENV_TMP" "$ENV_FILE"

echo "[6/6] Starting service and checking HTTP health"
if ! "$BASE/bin/rebotarm-start.sh" || ! "$BASE/bin/rebotarm-health.sh"; then
    echo "new release is unhealthy; rolling back to $PREVIOUS" >&2
    restart_previous || die "automatic rollback failed; inspect $BASE/shared/logs/server.out"
    exit 1
fi

echo "deployed: $RELEASE_ID"
echo "current : $(readlink "$BASE/current")"
echo "env copy: $ENV_BACKUP"
echo "UI       : http://127.0.0.1:8000/"
echo "NOTE: deployment did not configure CAN, scan motors, or issue motion commands."
