"""Optional single-origin static hosting for the built web UI (Vite dist).

Phase 7B: the same uvicorn process that serves ``/api`` and ``/ws`` can
*optionally* serve the pre-built frontend from a local directory, so a
Jetson user-space deployment needs no nginx/Node/docker.

Disabled by default. Enabled ONLY when ``REBOT_WEB_DIST_DIR`` is set to an
existing directory that contains an ``index.html``. Anything else —
unset/empty, missing path, a file instead of a directory, no ``index.html``
— fails closed: :class:`~rebot_server.config.ConfigError` at app creation,
the server refuses to start (or, in tests, the app factory raises).

Safety properties (all fail closed, none adds control capability):

* The API surface always wins: the catch-all route is registered AFTER the
  API/WebSocket router, and unknown ``/api/*``, ``/ws/*``, ``/docs*``,
  ``/redoc*`` and ``/openapi.json`` paths return a plain 404 instead of the
  SPA (no API typo is ever masked by an HTML page).
* Path traversal guard: every request path is resolved (``os.path.realpath``,
  symlinks included) and must stay inside the validated root — otherwise 404.
* Hidden files (any path segment starting with ``.``) are never served.
* Existing files are served as-is; directories serve their ``index.html``;
  anything else falls back to the root ``index.html`` (SPA client-side
  routing contract — identical to ``vite preview`` behavior).
* Read-only: this module never writes, never executes anything, and serves
  only files under the operator-provided root.
"""

from __future__ import annotations

import os
from pathlib import Path

from .config import ConfigError

#: Path prefixes that belong to the backend, never to the SPA. Unknown paths
#: under these prefixes yield 404 (fail closed) instead of index.html.
_RESERVED_PREFIXES = ("/api/", "/ws/", "/docs", "/redoc")
_RESERVED_EXACT = ("/api", "/ws", "/openapi.json")


def validate_web_root(raw: str) -> Path:
    """Validate ``REBOT_WEB_DIST_DIR`` and return the resolved root.

    Raises :class:`ConfigError` (fail closed) when the value is empty, the
    path does not exist, is not a directory, or lacks ``index.html``. The
    returned path is fully resolved (symlinks followed) so the request-time
    containment check has a stable anchor.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ConfigError(
            "REBOT_WEB_DIST_DIR is empty: static hosting requires an "
            "existing directory with index.html (fail closed)"
        )
    candidate = Path(raw.strip()).expanduser()
    if not candidate.exists():
        raise ConfigError(
            f"REBOT_WEB_DIST_DIR does not exist: {candidate} (fail closed)"
        )
    if not candidate.is_dir():
        raise ConfigError(
            f"REBOT_WEB_DIST_DIR is not a directory: {candidate} (fail closed)"
        )
    index = candidate / "index.html"
    if not index.is_file():
        raise ConfigError(
            f"REBOT_WEB_DIST_DIR has no index.html: {candidate} (fail closed)"
        )
    return candidate.resolve()


def _is_hidden(path: str) -> bool:
    """True when any URL path segment is a dotfile/dotdir."""
    return any(
        segment.startswith(".") for segment in path.split("/") if segment
    )


def create_static_web_router(root: Path):
    """Build the catch-all GET router serving *root* with SPA fallback.

    Include it AFTER the API router so backend routes keep priority.
    """
    from fastapi import APIRouter
    from fastapi.responses import FileResponse, PlainTextResponse

    router = APIRouter()
    root_str = str(root.resolve())
    index_file = root / "index.html"

    def _fallback() -> FileResponse:
        return FileResponse(str(index_file), media_type="text/html")

    @router.get("/{full_path:path}")
    def static_or_spa(full_path: str):
        # ``full_path`` arrives URL-decoded and without a leading slash.
        as_path = "/" + full_path
        if as_path in _RESERVED_EXACT or as_path.startswith(_RESERVED_PREFIXES):
            return PlainTextResponse("Not Found", status_code=404)
        if _is_hidden(full_path):
            return PlainTextResponse("Not Found", status_code=404)

        # Containment guard (fail closed): realpath collapses ``..`` and
        # follows symlinks; anything escaping the root is a 404.
        try:
            resolved = os.path.realpath(os.path.join(root_str, full_path))
        except (OSError, ValueError):
            return PlainTextResponse("Not Found", status_code=404)
        if resolved != root_str and not resolved.startswith(root_str + os.sep):
            return PlainTextResponse("Not Found", status_code=404)

        if os.path.isfile(resolved):
            # Directory-listing is impossible: only direct file hits serve.
            return FileResponse(resolved)
        if os.path.isdir(resolved):
            nested_index = os.path.join(resolved, "index.html")
            nested_real = os.path.realpath(nested_index)
            if (
                nested_real.startswith(root_str + os.sep)
                and os.path.isfile(nested_real)
            ):
                return FileResponse(nested_real, media_type="text/html")
        # SPA fallback for unknown routes (client-side routing).
        return _fallback()

    return router
