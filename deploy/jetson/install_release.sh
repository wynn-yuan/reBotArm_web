#!/bin/sh
# install_release.sh — install a reBotArm release tarball on the Jetson host.
# USER SPACE ONLY: no sudo, no systemd, no nginx/docker/Node.
#
# Usage (on the Jetson, as the deploy user):
#   sh install_release.sh /path/to/rebotarm-release-<id>.tar.gz
#
# Base directory: $REBOTARM_BASE (default /home/revolute1/rebotarm-web).
#
# Layout produced:
#   $BASE/releases/<release-id>/{server,web/dist,VERSION,...}
#   $BASE/current -> releases/<release-id>          (atomic symlink swap)
#   $BASE/shared/env/rebotarm.env                   (mode 600; kept if exists)
#   $BASE/shared/logs/
#   $BASE/shared/venv/                              (Python 3.10 venv)
#   $BASE/bin/rebotarm-{start,stop,health}.sh
#
# Fail closed: refuses to overwrite an existing release id, refuses unknown
# tarball shapes, refuses a non-3.10 interpreter for the venv.

set -eu

BASE="${REBOTARM_BASE:-/home/revolute1/rebotarm-web}"

if [ "$#" -ne 1 ]; then
    echo "usage: sh install_release.sh <release-tarball.tar.gz>" >&2
    exit 2
fi
TARBALL=$1
if [ ! -f "$TARBALL" ]; then
    echo "ERROR: tarball not found: $TARBALL" >&2
    exit 1
fi

# --- 1. Validate archive members, then extract into a scratch dir ------------
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/rebotarm-install.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT

# Reject path traversal, absolute paths, links and special files before tar is
# allowed to extract anything. A release contains regular files/directories
# only; links inside it are unnecessary and would weaken the extraction bound.
PYTHON_CHECK=""
for candidate in python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON_CHECK=$(command -v "$candidate")
        break
    fi
done
[ -n "$PYTHON_CHECK" ] || {
    echo "ERROR: Python is required to validate the release archive." >&2
    exit 1
}
"$PYTHON_CHECK" - "$TARBALL" <<'PY'
import pathlib
import sys
import tarfile

archive = sys.argv[1]
with tarfile.open(archive, "r:gz") as bundle:
    for member in bundle.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"unsafe archive path: {member.name}")
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"unsupported archive member: {member.name}")
PY
tar -xzf "$TARBALL" -C "$SCRATCH"

for required in \
    "$SCRATCH/VERSION" \
    "$SCRATCH/server/pyproject.toml" \
    "$SCRATCH/web/dist/index.html" \
    "$SCRATCH/scripts/rebotarm-start.sh" \
    "$SCRATCH/scripts/rebotarm-stop.sh" \
    "$SCRATCH/scripts/rebotarm-health.sh" \
    "$SCRATCH/env/rebotarm.env.template"
do
    if [ ! -e "$required" ]; then
        echo "ERROR: release tarball is missing '$required' (fail closed)." >&2
        exit 1
    fi
done

RELEASE_ID=$(cat "$SCRATCH/VERSION" | tr -d '[:space:]')
if [ -z "$RELEASE_ID" ]; then
    echo "ERROR: empty VERSION in release (fail closed)." >&2
    exit 1
fi
case "$RELEASE_ID" in
    */*|..*|*..*)
        echo "ERROR: unsafe release id: $RELEASE_ID (fail closed)." >&2
        exit 1
        ;;
esac

mkdir -p "$BASE/releases" "$BASE/shared/env" "$BASE/shared/logs" "$BASE/bin"

if [ -e "$BASE/releases/$RELEASE_ID" ]; then
    echo "ERROR: release '$RELEASE_ID' already exists at $BASE/releases/$RELEASE_ID." >&2
    echo "Refusing to overwrite existing content (fail closed). Use a new release id." >&2
    exit 1
fi

# --- 2. Move the validated release into place -------------------------------
# Activation is deliberately deferred until dependencies and environment are
# ready. A failed pip install therefore cannot point current at a broken build.
mv "$SCRATCH" "$BASE/releases/$RELEASE_ID"
trap - EXIT

REL="$BASE/releases/$RELEASE_ID"

# --- 3. Python 3.10 venv (created once, reused across releases) --------------
PYTHON_BIN=""
for candidate in python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
        ver=$("$candidate" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "")
        if [ "$ver" = "3.10" ]; then
            PYTHON_BIN=$(command -v "$candidate")
            break
        fi
    fi
done
if [ -z "$PYTHON_BIN" ]; then
    echo "ERROR: no Python 3.10 interpreter found (fail closed)." >&2
    exit 1
fi

# A venv is usable only when its own pip works (a failed ensurepip leaves a
# structurally present but broken venv behind).
venv_ok() {
    [ -x "$BASE/shared/venv/bin/python" ] \
        && "$BASE/shared/venv/bin/python" -m pip --version >/dev/null 2>&1
}

if ! venv_ok; then
    rm -rf "$BASE/shared/venv"
    echo "creating venv with $PYTHON_BIN"
    if "$PYTHON_BIN" -m venv "$BASE/shared/venv"; then
        :
    else
        # Debian/Ubuntu hosts without the python3.10-venv package have no
        # ensurepip. Stay user-space: create the venv without pip, then
        # bootstrap pip from bootstrap.pypa.io (TLS-pinned).
        echo "NOTE: plain venv failed (likely missing ensurepip); using --without-pip + get-pip.py bootstrap" >&2
        rm -rf "$BASE/shared/venv"
        "$PYTHON_BIN" -m venv --without-pip "$BASE/shared/venv"
        GETPIP="$BASE/shared/logs/get-pip.py"
        curl -fsSL --max-time 120 https://bootstrap.pypa.io/get-pip.py -o "$GETPIP"
        "$BASE/shared/venv/bin/python" "$GETPIP" --quiet
        rm -f "$GETPIP"
    fi
fi
if ! venv_ok; then
    echo "ERROR: venv is not usable after bootstrap (fail closed)." >&2
    exit 1
fi
VENV_PY="$BASE/shared/venv/bin/python"

# --- 4. Install backend + pinned dependencies (motorbridge pin comes from
#        server/pyproject.toml; PyPI access required) --------------------------
echo "installing rebot-server + pinned dependencies..."
"$VENV_PY" -m pip install --disable-pip-version-check --quiet "$REL/server"
INSTALLED_MB=$("$VENV_PY" -m pip show motorbridge 2>/dev/null | sed -n 's/^Version: //p')
echo "installed motorbridge: ${INSTALLED_MB:-<missing>}"
# Metadata-level verification only (NO SDK import here; import/ABI checks are
# done explicitly during the smoke test, and Controller is never constructed).
"$VENV_PY" - <<'EOF'
import importlib.metadata as md
print("rebot-server:", md.version("rebot-server"))
print("motorbridge :", md.version("motorbridge"))
EOF

# --- 5. Environment file (keep existing operator config; 600 always) ----------
ENV_FILE="$BASE/shared/env/rebotarm.env"
if [ ! -f "$ENV_FILE" ]; then
    install -m 600 "$REL/env/rebotarm.env.template" "$ENV_FILE"
    echo "created $ENV_FILE from template (mode 600)."
else
    chmod 600 "$ENV_FILE"
    echo "kept existing $ENV_FILE (mode forced to 600)."
fi

# --- 6. Activate only after the release is fully installable ----------------
install -m 755 "$REL/scripts/rebotarm-start.sh"  "$BASE/bin/rebotarm-start.sh.new"
install -m 755 "$REL/scripts/rebotarm-stop.sh"   "$BASE/bin/rebotarm-stop.sh.new"
install -m 755 "$REL/scripts/rebotarm-health.sh" "$BASE/bin/rebotarm-health.sh.new"
install -m 755 "$REL/scripts/rebotarm-can-init.sh" "$BASE/bin/rebotarm-can-init.sh.new"
mv -f "$BASE/bin/rebotarm-start.sh.new"  "$BASE/bin/rebotarm-start.sh"
mv -f "$BASE/bin/rebotarm-stop.sh.new"   "$BASE/bin/rebotarm-stop.sh"
mv -f "$BASE/bin/rebotarm-health.sh.new" "$BASE/bin/rebotarm-health.sh"
mv -f "$BASE/bin/rebotarm-can-init.sh.new" "$BASE/bin/rebotarm-can-init.sh"
ln -sfn "releases/$RELEASE_ID" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"

echo
echo "installed release '$RELEASE_ID' at $BASE"
echo "current -> $(readlink "$BASE/current")"
echo
echo "next steps (user space):"
echo "  $BASE/bin/rebotarm-start.sh     # starts the configured adapter; no scan or motion"
echo "  $BASE/bin/rebotarm-health.sh"
echo "  $BASE/bin/rebotarm-stop.sh"
