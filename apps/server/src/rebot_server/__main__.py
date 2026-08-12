"""Entry point: ``python -m rebot_server`` (or the ``rebot-server`` script).

Safety: refuses to run as root unless REBOT_ALLOW_ROOT=1 — a robot backend
should run as an unprivileged user; bring ``can0`` up separately (see README).
"""

from __future__ import annotations

import logging
import os
import sys


def _allow_root() -> bool:
    return os.environ.get("REBOT_ALLOW_ROOT", "").strip().lower() in {
        "1", "true", "yes", "on",
    }


def main() -> int:
    from .config import ConfigError, load_settings
    from .logutil import configure_logging

    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    configure_logging(level=settings.log_level, json_output=settings.log_json)
    logger = logging.getLogger("rebot_server")

    if hasattr(os, "geteuid") and os.geteuid() == 0 and not _allow_root():
        logger.error(
            "refusing to run as root: run as an unprivileged user; bring the "
            "CAN interface up separately (sudo ip link set ...); see README"
        )
        return 2

    from .app import create_app

    try:
        app = create_app(settings)
    except Exception as exc:
        logger.error("failed to create application: %s: %s", type(exc).__name__, exc)
        return 1

    try:
        import uvicorn
    except ImportError:
        logger.error(
            "uvicorn is not installed; install dependencies first "
            "(pip install -e .)"
        )
        return 2

    logger.info(
        "starting rebot-server",
        extra={
            "adapter": settings.adapter,
            "channel": settings.channel,
            "host": settings.host,
            "port": settings.port,
        },
    )
    # log_config=None keeps uvicorn's loggers propagating to our structured
    # root handler instead of uvicorn's default formatting.
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        log_config=None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
