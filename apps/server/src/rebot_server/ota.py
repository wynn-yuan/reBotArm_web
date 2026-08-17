"""Remote OTA (Over-The-Air) update endpoint.

Upload a pre-built release tarball via the web UI and trigger an atomic
install + restart. The install runs in a background script so the active
request handler can finish before the service stops.
"""

from __future__ import annotations

import hashlib
import logging
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import time
from typing import Optional

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

router = APIRouter()

#: Uploaded tarballs must be under this size (200 MiB).
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
#: Required archive members (same as install_release.sh).
_REQUIRED_MEMBERS = (
    "VERSION",
    "server/pyproject.toml",
    "web/dist/index.html",
    "scripts/rebotarm-start.sh",
    "scripts/rebotarm-stop.sh",
    "scripts/rebotarm-health.sh",
)


def _validate_tarball(path: str) -> str:
    """Return the release id from a validated tarball, or raise ValueError."""
    if not os.path.isfile(path):
        raise ValueError("tarball not found")
    with tarfile.open(path, "r:gz") as bundle:
        for member in bundle.getmembers():
            p = pathlib.PurePosixPath(member.name)
            if p.is_absolute() or ".." in p.parts:
                raise ValueError(f"unsafe archive path: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise ValueError(f"unsupported archive member: {member.name}")
        names = {m.name for m in bundle.getmembers()}
    for required in _REQUIRED_MEMBERS:
        if required not in names:
            raise ValueError(f"missing required member: {required}")
    with tarfile.open(path, "r:gz") as bundle:
        version_file = bundle.extractfile("VERSION")
        if version_file is None:
            raise ValueError("cannot read VERSION")
        release_id = version_file.read().decode("utf-8").strip()
    if not release_id or "/" in release_id or ".." in release_id:
        raise ValueError(f"unsafe release id: {release_id!r}")
    return release_id


def _resolve_base() -> str:
    """Resolve $BASE from the well-known current symlink."""
    base = os.environ.get("REBOTARM_BASE", "")
    if base:
        return base
    # Fallback: follow the current symlink
    current = pathlib.Path(__file__).resolve().parent.parent.parent.parent.parent
    # __file__ is .../releases/<id>/server/src/rebot_server/ota.py
    # 4 levels up: .../releases/<id>/
    # 1 more: .../ (the BASE)
    return str(current.parent)


@router.get("/api/ota/status")
def get_ota_status(request: Request) -> dict:
    """Return the current version and deployment info."""
    settings = request.app.state.settings
    base = _resolve_base()
    current = os.path.join(base, "current")
    release_id = None
    if os.path.islink(current):
        target = os.readlink(current)
        release_id = os.path.basename(target.rstrip("/"))
    start_time = getattr(request.app.state, "_started_at", None)
    uptime = time.monotonic() - start_time if start_time else 0.0
    return {
        "version": __import__("rebot_server").__version__,
        "release_id": release_id,
        "adapter": settings.adapter,
        "can_channel": settings.channel,
        "uptime_seconds": round(uptime, 1),
    }


@router.post("/api/ota/update")
async def post_ota_update(
    request: Request,
    file: UploadFile = File(...),
    confirm: str = Form("false"),
) -> dict:
    """Upload a release tarball and trigger an atomic install + restart.

    The tarball is validated, saved to a temporary location, and installed
    by a background script. The current process returns immediately; the
    background script stops the service, installs the release, and starts
    the new version.
    """
    if confirm != "true":
        return JSONResponse(
            {"error": "upload requires confirm=true"},
            status_code=400,
        )

    # Gate: no aging or zero-torque active
    aging = request.app.state.aging_runtime.status()
    if aging.get("status") not in ("inactive", "completed", "held", "error"):
        return JSONResponse(
            {"error": "aging is active; stop aging before OTA update"},
            status_code=409,
        )
    zero = request.app.state.writes.zero_torque_status()
    if zero.get("status") != "inactive":
        return JSONResponse(
            {"error": "zero-torque is active; exit zero-torque before OTA update"},
            status_code=409,
        )

    # Read the upload
    if file.filename is None or not file.filename.endswith(".tar.gz"):
        return JSONResponse(
            {"error": "only .tar.gz release tarballs are accepted"},
            status_code=400,
        )

    tmpdir = tempfile.mkdtemp(prefix="rebotarm-ota-")
    tarball_path = os.path.join(tmpdir, "release.tar.gz")
    try:
        # Stream to temp file
        total = 0
        with open(tarball_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1 MiB chunks
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    return JSONResponse(
                        {"error": f"tarball exceeds {MAX_UPLOAD_BYTES // 1024 // 1024} MiB limit"},
                        status_code=413,
                    )
                f.write(chunk)

        # Validate
        release_id = _validate_tarball(tarball_path)
        base = _resolve_base()
        releases_dir = os.path.join(base, "releases")
        if os.path.exists(os.path.join(releases_dir, release_id)):
            return JSONResponse(
                {"error": f"release {release_id} already exists"},
                status_code=409,
            )

        logger.info("OTA: validated release %s (%d bytes)", release_id, total)

        # Write the background install script
        install_script = os.path.join(tmpdir, "install.sh")
        with open(install_script, "w") as f:
            f.write(f"""#!/bin/sh
set -eu
BASE="{base}"
TARBALL="{tarball_path}"
TMPDIR="{tmpdir}"
RELEASE_ID="{release_id}"

echo "[OTA] stopping service..."
"$BASE/bin/rebotarm-stop.sh" 2>/dev/null || true
sleep 1

echo "[OTA] extracting release $RELEASE_ID..."
mkdir -p "$BASE/releases"
EXTRACT_DIR="$TMPDIR/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$TARBALL" -C "$EXTRACT_DIR"

# Move into releases
if [ -e "$BASE/releases/$RELEASE_ID" ]; then
    echo "[OTA] ERROR: release already exists"
    rm -rf "$TMPDIR"
    exit 1
fi
mv "$EXTRACT_DIR" "$BASE/releases/$RELEASE_ID"
REL="$BASE/releases/$RELEASE_ID"

echo "[OTA] installing server package..."
"$BASE/shared/venv/bin/pip" install --disable-pip-version-check --quiet "$REL/server"

echo "[OTA] activating release..."
install -m 755 "$REL/scripts/rebotarm-start.sh"  "$BASE/bin/rebotarm-start.sh"
install -m 755 "$REL/scripts/rebotarm-stop.sh"   "$BASE/bin/rebotarm-stop.sh"
install -m 755 "$REL/scripts/rebotarm-health.sh" "$BASE/bin/rebotarm-health.sh"
ln -sfn "releases/$RELEASE_ID" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"

echo "[OTA] starting service..."
"$BASE/bin/rebotarm-start.sh" 2>&1

echo "[OTA] cleaning up..."
rm -rf "$TMPDIR"

echo "[OTA] done: $RELEASE_ID"
""")
        os.chmod(install_script, 0o755)

        # Launch in background
        subprocess.Popen(
            ["sh", install_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        logger.info("OTA: background install started for release %s", release_id)
        return {
            "status": "installing",
            "release_id": release_id,
            "message": "OTA update started; service will restart in ~15 seconds",
        }
    except ValueError as exc:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return JSONResponse(
            {"error": f"invalid tarball: {exc}"},
            status_code=400,
        )
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise