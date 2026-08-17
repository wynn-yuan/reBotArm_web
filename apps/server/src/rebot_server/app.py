"""Application factory wiring settings, adapter and service together."""

from __future__ import annotations

import time
from typing import Optional

from . import __version__
from .api import router
from .aging_logs import AgingLogStore
from .aging_recorder import AgingRecorder
from .aging_runtime import AgingRuntime
from .config import ADAPTER_MOTORBRIDGE, Settings, load_settings
from .gravity import GravityModel
from .ota import router as ota_router
from .scanners import create_scanner
from .scanners.base import CanScanner
from .scanners.motorbridge import (
    sdk_supports_aging_motion,
    sdk_supports_persistent_gains,
    sdk_supports_set_zero,
    sdk_supports_zero_torque,
)
from .sdkcheck import import_verified_sdk, read_abi_version
from .service import ScanService
from .writes import WriteController

# CORS default when no explicit origins are configured: only
# localhost / 127.0.0.1 on any port.
_LOCALHOST_ORIGIN_REGEX = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"


def create_app(
    settings: Optional[Settings] = None,
    scanner: Optional[CanScanner] = None,
    service: Optional[ScanService] = None,
):
    """Create the FastAPI application.

    ``scanner`` / ``service`` overrides exist for dependency injection in
    tests; production lets the settings decide.

    Startup SDK gate (fail closed): with ``REBOT_ADAPTER=motorbridge`` the
    installed motorbridge SDK is imported and must report exactly the
    verified version (0.5.1), and its native ABI must load; anything else
    raises :class:`~rebot_server.config.ConfigError` and the server does not
    start. With ``REBOT_ADAPTER=simulation`` the motorbridge package is
    NEVER imported.

    Optional static hosting (fail closed): when ``settings.web_dist_dir`` is
    set, the directory must exist and contain ``index.html`` — otherwise
    :class:`~rebot_server.config.ConfigError` and no server. The catch-all
    static route is registered AFTER the API router, so ``/api`` and ``/ws``
    always keep priority. Disabled by default.
    """
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    if settings is None:
        settings = load_settings()

    if settings.adapter == ADAPTER_MOTORBRIDGE:
        sdk_module = import_verified_sdk()  # raises ConfigError (fail closed)
        motorbridge_version = str(sdk_module.__version__)
        motorbridge_abi_version = read_abi_version(sdk_module)
    else:
        # Simulation mode must never import motorbridge.
        motorbridge_version = None
        motorbridge_abi_version = None

    if service is None:
        if scanner is None:
            scanner = create_scanner(settings)
        service = ScanService(
            scanner,
            settings.channel,
            settings.expected_ids,
            zero_torque_hz=settings.zero_torque_hz,
            require_all_motors=settings.require_all_motors,
        )

    # Active-report telemetry hub (motorbridge mode only). In simulation
    # mode it stays dormant: no SDK import, no session, no motor writes.
    from contextlib import asynccontextmanager

    from .activereport import MotorbridgeTelemetryHub

    # Fixed-root aging telemetry persistence. Constructing the recorder does
    # not start recording, read telemetry, or touch a device. Only an explicit
    # API start lets the existing hub frame observer enqueue CSV writes.
    aging_log_store = AgingLogStore(
        settings.aging_log_root,
        min_free_bytes=settings.aging_log_min_free_bytes,
        segment_seconds=settings.aging_log_segment_seconds,
        trajectory_root=settings.trajectory_dir,
    )
    aging_recorder = AgingRecorder(aging_log_store)

    # Gravity compensation: only instantiate when enabled and the URDF is
    # available.  Failures are logged but never prevent server startup (fail
    # open for the model — the torque feedforward simply stays 0).
    gravity_model = None
    if settings.gravity_compensation_enable:
        import os as _os
        import sys as _sys

        urdf_path = _os.environ.get("REBOT_URDF_PATH", "")
        if not urdf_path:
            # 开发环境路径
            dev_path = _os.path.join(
                _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.dirname(__file__)))),
                "packages",
                "robot-description",
                "public",
                "robots",
                "rebot-b601-rs",
                "model.urdf",
            )
            # 部署环境路径（Jetson: current/web/dist/robots/...）
            deploy_path = _os.path.join(
                _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.dirname(__file__)))),
                "web",
                "dist",
                "robots",
                "rebot-b601-rs",
                "model.urdf",
            )
            urdf_path = dev_path if _os.path.isfile(dev_path) else deploy_path
        if not _os.path.isfile(urdf_path):
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "gravity compensation enabled but URDF not found at %s; "
                "gravity torque will be 0",
                urdf_path,
            )
        else:
            try:
                gravity_model = GravityModel(
                    urdf_path,
                    compensation_factors=settings.gravity_compensation_factor,
                )
            except Exception as _exc:
                import logging as _logging
                _logging.getLogger(__name__).warning(
                    "failed to load gravity model: %s; gravity torque will be 0",
                    _exc,
                )

    aging_runtime = AgingRuntime(settings, service, aging_recorder, gravity_model)
    telemetry_hub = MotorbridgeTelemetryHub(
        settings, service, frame_sink=aging_runtime.accept_frame
    )

    @asynccontextmanager
    async def lifespan(_app):
        # Service stop: stop the backend-owned zero-torque loop first, then
        # stop telemetry and release the single scanner/controller owner.
        yield
        aging_runtime.shutdown()
        service.shutdown_zero_torque()
        await telemetry_hub.shutdown()
        service.disconnect()

    # Capabilities (health endpoint). telemetry/active_report_write are true
    # for motorbridge only when the write is explicitly authorized AND the
    # SDK gate above has passed (it raises otherwise, so reaching this point
    # with adapter=motorbridge means the verified 0.5.1 SDK is available).
    active_report_write = (
        settings.adapter == ADAPTER_MOTORBRIDGE
        and settings.allow_active_report_write
    )
    persistent_gain_write = (
        settings.adapter == ADAPTER_MOTORBRIDGE
        and settings.allow_parameter_write
        and sdk_supports_persistent_gains(sdk_module)
        if settings.adapter == ADAPTER_MOTORBRIDGE
        else False
    )
    zero_torque = (
        settings.adapter == ADAPTER_MOTORBRIDGE
        and settings.allow_zero_torque_write
        and sdk_supports_zero_torque(sdk_module)
        if settings.adapter == ADAPTER_MOTORBRIDGE
        else False
    )
    set_zero = (
        settings.adapter == ADAPTER_MOTORBRIDGE
        and settings.allow_set_zero_write
        and sdk_supports_set_zero(sdk_module)
        if settings.adapter == ADAPTER_MOTORBRIDGE
        else False
    )
    aging_motion = (
        settings.adapter == ADAPTER_MOTORBRIDGE
        and settings.allow_aging_write
        and active_report_write
        and aging_log_store.enabled
        and sdk_supports_aging_motion(sdk_module)
        if settings.adapter == ADAPTER_MOTORBRIDGE
        else False
    )
    capabilities = {
        "scan": True,
        "telemetry": (
            settings.adapter != ADAPTER_MOTORBRIDGE or active_report_write
        ),
        "control": aging_motion,
        "homing": aging_motion,
        "enable": (
            settings.adapter == ADAPTER_MOTORBRIDGE
            and (settings.allow_enable_write or aging_motion)
        ),
        "disable": (
            settings.adapter == ADAPTER_MOTORBRIDGE
            and (settings.allow_enable_write or aging_motion)
        ),
        "parameter_write": False,
        "persistent_gain_write": persistent_gain_write,
        "mit_gain_write": False,
        "set_zero": set_zero,
        "zero_torque": zero_torque,
        "active_report_write": active_report_write,
    }

    app = FastAPI(
        title="reBotArm Server",
        version=__version__,
        description=(
            "motorbridge 0.5.1 scan and telemetry with separately gated "
            "manual enable/disable, persistent gains, backend-owned "
            "zero-torque mode, and a separately gated backend-owned aging cycle."
        ),
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.service = service
    app.state.telemetry_hub = telemetry_hub
    app.state.aging_log_store = aging_log_store
    app.state.aging_recorder = aging_recorder
    app.state.aging_runtime = aging_runtime
    app.state.writes = WriteController(settings, service)
    app.state.capabilities = capabilities
    app.state.motorbridge_version = motorbridge_version
    app.state.motorbridge_abi_version = motorbridge_abi_version
    app.state._started_at = time.monotonic()

    origins = list(settings.cors_origins)
    if "*" in origins:
        cors = {"allow_origins": ["*"]}
    else:
        cors = {
            "allow_origins": origins,
            # Empty origins => localhost-only default.
            "allow_origin_regex": None if origins else _LOCALHOST_ORIGIN_REGEX,
        }
    app.add_middleware(
        CORSMiddleware,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
        **cors,
    )
    app.include_router(router)
    app.include_router(ota_router)

    # Optional same-origin static hosting of the pre-built web UI. Included
    # AFTER the API router: /api and /ws always win. Fails closed at app
    # creation on any bad configuration (missing dir / no index.html).
    if settings.web_dist_dir:
        from .staticweb import create_static_web_router, validate_web_root

        web_root = validate_web_root(settings.web_dist_dir)
        app.state.web_root = str(web_root)
        app.include_router(create_static_web_router(web_root))
    return app
