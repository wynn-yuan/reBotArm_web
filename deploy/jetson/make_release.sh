#!/bin/sh
# make_release.sh — build a reBotArm release tarball LOCALLY (Phase 7B).
# Run from Git Bash / WSL / Linux. No Node needed here: the web dist must be
# pre-built already (npm run build in the repo root -> apps/web/dist).
#
# Usage:
#   sh deploy/jetson/make_release.sh [release-id]
# Output:
#   deploy/jetson/out/rebotarm-release-<release-id>.tar.gz  (安装包, full)
#   deploy/jetson/out/rebotarm-update-<release-id>.tar.gz   (更新包, no STL meshes)
#
# Tarball layout (consumed by install_release.sh ON the Jetson):
#   VERSION
#   server/{pyproject.toml,.env.example,src/}
#   web/dist/...
#   scripts/rebotarm-{start,stop,health}.sh
#   env/rebotarm.env.template

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

SERVER_DIR="$REPO_ROOT/apps/server"
WEB_DIST="$REPO_ROOT/apps/web/dist"

RELEASE_ID="${1:-$(date -u +%Y%m%d-%H%M%S)Z}"
case "$RELEASE_ID" in
    */*|*..*|"")
        echo "ERROR: unsafe release id: $RELEASE_ID" >&2
        exit 1
        ;;
esac

# --- preconditions (fail closed) ---------------------------------------------
[ -f "$SERVER_DIR/pyproject.toml" ] || { echo "ERROR: $SERVER_DIR/pyproject.toml missing" >&2; exit 1; }
[ -d "$SERVER_DIR/src/rebot_server" ] || { echo "ERROR: server sources missing" >&2; exit 1; }
[ -f "$WEB_DIST/index.html" ] || {
    echo "ERROR: $WEB_DIST/index.html missing — run 'npm run build' first." >&2
    exit 1
}

OUT_DIR="$SCRIPT_DIR/out"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/rebotarm-release.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

# --- stage --------------------------------------------------------------------
echo "$RELEASE_ID" >"$STAGE/VERSION"

mkdir -p "$STAGE/server" "$STAGE/web" "$STAGE/scripts" "$STAGE/env"
cp "$SERVER_DIR/pyproject.toml" "$SERVER_DIR/.env.example" "$STAGE/server/"
cp -r "$SERVER_DIR/src" "$STAGE/server/src"
cp -r "$WEB_DIST" "$STAGE/web/dist"
cp "$SCRIPT_DIR/bin/rebotarm-start.sh" \
   "$SCRIPT_DIR/bin/rebotarm-stop.sh" \
   "$SCRIPT_DIR/bin/rebotarm-health.sh" \
   "$SCRIPT_DIR/bin/rebotarm-can-init.sh" "$STAGE/scripts/"
cp "$SCRIPT_DIR/env/rebotarm.env.template" "$STAGE/env/"

# Drop any Python bytecode cruft from staging (never ship caches).
find "$STAGE" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/rebotarm-release-$RELEASE_ID.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" .

# Update package: same tree without the STL mesh dirs (the bulk of the
# bundle). The installer backfills meshes from the release in use.
STAGE_UPDATE=$(mktemp -d "${TMPDIR:-/tmp}/rebotarm-update.XXXXXX")
trap 'rm -rf "$STAGE" "$STAGE_UPDATE"' EXIT
cp -a "$STAGE"/. "$STAGE_UPDATE"/
find "$STAGE_UPDATE/web/dist/robots" -mindepth 2 -maxdepth 2 -type d -name meshes -exec rm -rf {} + 2>/dev/null || true
UPDATE_TARBALL="$OUT_DIR/rebotarm-update-$RELEASE_ID.tar.gz"
tar -czf "$UPDATE_TARBALL" -C "$STAGE_UPDATE" .

echo "built: $TARBALL"
echo "built: $UPDATE_TARBALL"
echo "release id: $RELEASE_ID"
ls -lh "$TARBALL" "$UPDATE_TARBALL" | sed 's/^/  /'
echo
echo "deploy (on a workstation with SSH access to the Jetson):"
echo "  scp -i <key> -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes \\"
echo "      $TARBALL <user>@<host>:~/rebotarm-install/"
echo "  ssh ... 'mkdir -p ~/rebotarm-install && sh install_release.sh ...'  # see README"
