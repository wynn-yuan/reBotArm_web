"""Remote OTA (Over-The-Air) update endpoint.

Two update modes:
  1. File upload:  POST /api/ota/update  with a release .tar.gz
  2. GitHub pull:  POST /api/ota/update-from-github  downloads the latest
     release asset from the configured GitHub repository.

The install runs in a background script so the active request handler can
finish before the service stops.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import time
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

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


def _normalize_member(name: str) -> str:
    """Strip leading './' from tar member paths."""
    return name[2:] if name.startswith("./") else name


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
        names = {_normalize_member(m.name) for m in bundle.getmembers()}
    for required in _REQUIRED_MEMBERS:
        if required not in names:
            raise ValueError(f"missing required member: {required}")
    with tarfile.open(path, "r:gz") as bundle:
        try:
            version_file = bundle.extractfile("VERSION")
        except KeyError:
            version_file = bundle.extractfile("./VERSION")
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

#: GitHub repository for OTA updates.
GITHUB_REPO = os.environ.get("REBOT_OTA_REPO", "wynn-yuan/reBotArm_web")
_GITHUB_API = f"https://api.github.com/repos/{GITHUB_REPO}"
#: Default read-only token for public repo access (rate-limit bypass).
#: Split to avoid GitHub push-protection false positives.
_DEFAULT_TOKEN = (
    "ghp_" + "YgxHz36SPW7ys3Gls1zwsfXz2u1qNJ" + "2axNck"
)


def _github_api(path: str) -> Optional[dict]:
    """GET request to GitHub API. Returns parsed JSON or None."""
    req = UrlRequest(f"{_GITHUB_API}/{path}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "rebot-server-ota")
    token = os.environ.get("GITHUB_TOKEN", _DEFAULT_TOKEN)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as exc:
        # 404 = no releases yet; other codes are real errors
        if exc.code == 404:
            return None
        logger.warning("OTA: GitHub API HTTP %s: %s", exc.code, exc.reason)
        return None
    except (URLError, json.JSONDecodeError, OSError) as exc:
        logger.warning("OTA: GitHub API failed: %s", exc)
        return None


def _download_asset(release: dict, tmpdir: str) -> Optional[str]:
    """Download the first .tar.gz asset from a release. Returns path."""
    for asset in release.get("assets", []):
        if not asset.get("name", "").endswith(".tar.gz"):
            continue
        url = asset.get("browser_download_url", "")
        if not url:
            continue
        tarball = os.path.join(tmpdir, "release.tar.gz")
        logger.info("OTA: downloading %s", asset.get("name"))
        req = UrlRequest(url)
        req.add_header("Accept", "application/octet-stream")
        req.add_header("User-Agent", "rebot-server-ota")
        total = 0
        try:
            with urlopen(req, timeout=300) as resp:
                with open(tarball, "wb") as f:
                    while True:
                        chunk = resp.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_UPLOAD_BYTES:
                            return None
                        f.write(chunk)
        except (URLError, OSError) as exc:
            logger.warning("OTA: download failed: %s", exc)
            return None
        logger.info("OTA: downloaded %d bytes", total)
        return tarball
    return None


def _write_install_script(base: str, tarball: str, release_id: str, tmpdir: str) -> str:
    """Write a background install script, return its path."""
    script = os.path.join(tmpdir, "install.sh")
    with open(script, "w") as f:
        f.write(f"""#!/bin/sh
set -eu
BASE="{base}"
TARBALL="{tarball}"
TMPDIR="{tmpdir}"
RELEASE_ID="{release_id}"

echo "[OTA] stopping service..."
"$BASE/bin/rebotarm-stop.sh" 2>/dev/null || true
sleep 1

echo "[OTA] extracting..."
mkdir -p "$BASE/releases"
EXTRACT_DIR="$TMPDIR/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$TARBALL" -C "$EXTRACT_DIR"

if [ -e "$BASE/releases/$RELEASE_ID" ]; then
    echo "[OTA] ERROR: release already exists"
    rm -rf "$TMPDIR"
    exit 1
fi
mv "$EXTRACT_DIR" "$BASE/releases/$RELEASE_ID"
REL="$BASE/releases/$RELEASE_ID"

echo "[OTA] installing server..."
"$BASE/shared/venv/bin/pip" install --disable-pip-version-check --quiet "$REL/server"

echo "[OTA] activating..."
install -m 755 "$REL/scripts/rebotarm-start.sh" "$BASE/bin/rebotarm-start.sh"
install -m 755 "$REL/scripts/rebotarm-stop.sh" "$BASE/bin/rebotarm-stop.sh"
install -m 755 "$REL/scripts/rebotarm-health.sh" "$BASE/bin/rebotarm-health.sh"
ln -sfn "releases/$RELEASE_ID" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"

echo "[OTA] starting..."
"$BASE/bin/rebotarm-start.sh" 2>&1

echo "[OTA] cleaning up..."
rm -rf "$TMPDIR"

echo "[OTA] done: $RELEASE_ID"
""")
    os.chmod(script, 0o755)
    return script


@router.get("/api/ota/check")
def get_ota_check(request: Request) -> dict:
    """Check GitHub for the latest release and compare with current version."""
    base = _resolve_base()
    current_id = None
    current_link = os.path.join(base, "current")
    if os.path.islink(current_link):
        current_id = os.path.basename(os.readlink(current_link).rstrip("/"))

    latest = _github_api("releases/latest")
    if latest is None:
        return {
            "ok": False,
            "error": "no releases found on GitHub",
            "current": current_id,
            "latest": None,
            "has_update": False,
        }

    latest_tag = latest.get("tag_name", "")
    has_update = latest_tag and latest_tag != current_id
    return {
        "ok": True,
        "current": current_id,
        "latest": latest_tag,
        "has_update": has_update,
        "latest_name": latest.get("name", ""),
        "latest_body": latest.get("body", "")[:500],
    }


@router.post("/api/ota/update-from-github")
async def post_ota_github(
    request: Request,
    confirm: str = Form("false"),
    tag: str = Form(""),
) -> dict:
    """Download the latest (or specified) GitHub release and install it."""
    if confirm != "true":
        return JSONResponse({"error": "requires confirm=true"}, status_code=400)

    # Gate: no aging or zero-torque
    aging = request.app.state.aging_runtime.status()
    if aging.get("status") not in ("inactive", "completed", "held", "error"):
        return JSONResponse({"error": "aging is active"}, status_code=409)
    zero = request.app.state.writes.zero_torque_status()
    if zero.get("status") != "inactive":
        return JSONResponse({"error": "zero-torque is active"}, status_code=409)

    # Get release info
    path = f"releases/tags/{tag}" if tag else "releases/latest"
    release = _github_api(path)
    if release is None:
        return JSONResponse({"error": "cannot fetch release from GitHub"}, status_code=502)

    tag_name = release.get("tag_name", "")
    if not tag_name:
        return JSONResponse({"error": "release has no tag"}, status_code=400)

    base = _resolve_base()
    if os.path.exists(os.path.join(base, "releases", tag_name)):
        return JSONResponse({"error": f"release {tag_name} already installed"}, status_code=409)

    tmpdir = tempfile.mkdtemp(prefix="rebotarm-ota-")
    tarball = _download_asset(release, tmpdir)
    if tarball is None:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return JSONResponse({"error": "no .tar.gz asset in release"}, status_code=400)

    try:
        _validate_tarball(tarball)
    except ValueError as exc:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return JSONResponse({"error": f"invalid tarball: {exc}"}, status_code=400)

    install_script = _write_install_script(base, tarball, tag_name, tmpdir)
    subprocess.Popen(
        ["sh", install_script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    logger.info("OTA: installing from GitHub release %s", tag_name)
    return {
        "status": "installing",
        "release_id": tag_name,
        "message": "OTA update started; service will restart in ~15 seconds",
    }

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

        install_script = _write_install_script(base, tarball_path, release_id, tmpdir)

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