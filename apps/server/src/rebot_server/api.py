"""HTTP API (FastAPI). This is the only module that depends on FastAPI.

Contract:

    GET  /api/health             service health
    GET  /api/robot/connection   latest scan result (or initial state)
    POST /api/robot/scan         run a full serial scan (409 while one runs)
    POST /api/robot/disconnect   clear service state (blocked in zero-torque mode)
    GET/POST /api/robot/zero-torque/{status,start,stop}
    POST /api/robot/parameters/gains  verified persistent gain write
    POST /api/robot/parameters/zero   verified mechanical-zero write
    WS   /ws/robot/telemetry     read-only joint telemetry stream

General-purpose motion-control endpoints remain unavailable. Aging start/stop
owns the confirmed POS_VEL loop and existing-telemetry recording as one gated
lifecycle. The mechanical-zero endpoint is separately gated.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Request, WebSocket
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import SERVICE_NAME, __version__
from .config import ADAPTER_SIMULATION
from .aging_logs import AgingLogError
from .aging_recorder import AgingRecorderError
from .aging_runtime import AgingRuntime, AgingRuntimeError
from .models import utc_now_iso
from .service import BusBusyError, ScanInProgressError, ZeroTorqueBusyError
from .telemetry import stream_simulation_telemetry
from .writes import WriteController, WriteOpError

router = APIRouter()

ConnectionStatus = Literal[
    "disconnected", "scanning", "connected", "partial", "error"
]

#: Fail-closed capabilities if the app state lacks them (never claim a
#: capability that was not explicitly established at startup).
_SAFE_CAPABILITIES = {
    "scan": True,
    "telemetry": False,
    "enable": False,
    "control": False,
    "homing": False,
    "disable": False,
    "parameter_write": False,
    "persistent_gain_write": False,
    "mit_gain_write": False,
    "set_zero": False,
    "zero_torque": False,
    "active_report_write": False,
}


class Capabilities(BaseModel):
    """Startup-established, separately gated capabilities."""

    scan: bool
    telemetry: bool
    enable: bool
    control: bool
    homing: bool
    disable: bool
    parameter_write: bool
    persistent_gain_write: bool = False
    mit_gain_write: bool = False
    set_zero: bool = False
    zero_torque: bool = False
    #: True only with REBOT_ADAPTER=motorbridge AND
    #: REBOT_ALLOW_ACTIVE_REPORT_WRITE=1 (and the SDK gate passed).
    active_report_write: bool


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    adapter: str
    channel: str
    # motorbridge SDK info — only populated when REBOT_ADAPTER=motorbridge.
    # In simulation mode these are null and the SDK is never imported.
    motorbridge_version: Optional[str] = None
    motorbridge_abi_version: Optional[str] = None
    capabilities: Capabilities
    time: str


class RobotConnectionResponse(BaseModel):
    status: ConnectionStatus
    channel: str
    expected_ids: List[int]
    found_ids: List[int]
    missing_ids: List[int]
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    source: Optional[str] = None
    message: Optional[str] = None
    #: Same capabilities as /api/health (established at startup, fail-closed
    #: fallback if absent). Included so a client that only restores the
    #: connection state can still gate telemetry fail-closed WITHOUT trusting
    #: a source-derived guess: telemetry opens only when the server itself
    #: says telemetry is available.
    capabilities: Optional[Capabilities] = None


class ManualActionRequest(BaseModel):
    """Second confirmation barrier: only an explicit true is accepted."""

    confirm: bool = False


class PersistentGainChange(BaseModel):
    motor_id: int
    kp: float
    kd: float


class PersistentGainsRequest(BaseModel):
    confirm: bool = False
    changes: List[PersistentGainChange]


class AgingDirectoryRequest(BaseModel):
    """Root-relative directory management only; never a device command."""

    path: str = ""
    # ``directory`` is accepted as a readable alias for clients that use the
    # same name as the backend method.  Both values are still validated by
    # aging_logs.py.
    directory: Optional[str] = None


class AgingSessionCreateRequest(BaseModel):
    directory: str = ""
    path: Optional[str] = None
    session: Dict[str, Any] = Field(default_factory=dict)
    raw_action: Any = Field(default_factory=dict)
    processed_action: Any = Field(default_factory=dict)


class AgingJsonDocumentRequest(BaseModel):
    payload: Any


class AgingEventRequest(BaseModel):
    event: Dict[str, Any]


class AgingCycleConfigRequest(BaseModel):
    loop_mode: str
    loop_count: Optional[int] = None
    duration_minutes: Optional[float] = None
    interval_sec: float = 0.0
    # Optional temperature protection: any joint MOS temperature reaching this
    # value stops aging and returns home (event written to the session log).
    temp_limit_c: Optional[float] = None


class AgingRecordingStartRequest(BaseModel):
    confirm: bool = False
    action: Dict[str, Any] = Field(default_factory=dict)
    # Preferred: the backend reads the action from the Trajectory directory by
    # id. When absent, the full action object may be supplied inline instead.
    action_id: Optional[str] = None
    config: AgingCycleConfigRequest = Field(
        default_factory=lambda: AgingCycleConfigRequest(loop_mode="")
    )


class AgingActionRequest(BaseModel):
    action: Dict[str, Any] = Field(default_factory=dict)


def _with_capabilities(request: Request, snapshot: dict) -> dict:
    """Attach the startup-established capabilities to a connection snapshot.

    Falls back to ``_SAFE_CAPABILITIES`` (fail closed) when the app state
    lacks them — identical semantics to ``get_health``. Never mutates the
    service snapshot.
    """
    state = request.app.state
    return {
        **snapshot,
        "capabilities": getattr(state, "capabilities", _SAFE_CAPABILITIES),
    }


def _aging_store(request: Request):
    return request.app.state.aging_log_store


def _aging_error(exc) -> JSONResponse:
    return JSONResponse(
        status_code=getattr(exc, "status_code", 503),
        content={
            "error": {
                "code": getattr(exc, "code", "aging_log_error"),
                "message": str(exc),
            }
        },
    )


@router.get("/api/aging/logs")
def get_aging_log_status(request: Request) -> dict:
    """Report the fixed persistence root and real aging capability."""
    status = _aging_store(request).status()
    status["aging_recording_available"] = request.app.state.aging_recorder.available
    status["aging_execution_available"] = request.app.state.aging_runtime.available
    return status


@router.get("/api/aging/status")
def get_aging_recording_status(request: Request) -> dict:
    return request.app.state.aging_runtime.status()


@router.post("/api/aging/start")
def post_aging_recording_start(request: Request, body: AgingRecordingStartRequest):
    """Start real looped motion and existing-telemetry recording together."""
    if body.confirm is not True:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "confirmation_required", "message": "用户确认是必需的"}},
        )
    snapshot = request.app.state.service.snapshot()
    if snapshot.get("status") != "connected":
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "aging_requires_connected", "message": "老化要求机械臂和实时遥测已连接"}},
        )
    if request.app.state.settings.adapter == ADAPTER_SIMULATION:
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "aging_requires_motorbridge", "message": "老化仅允许使用真实 motorbridge 数据"}},
        )
    try:
        config = body.config.model_dump() if hasattr(body.config, "model_dump") else body.config.dict()
        # The action is loaded from the Trajectory directory by id when given,
        # so aging always executes the single source of truth on disk. The
        # inline action object is kept for backward compatibility / tests.
        if body.action_id:
            action = _aging_store(request).get_action(body.action_id)
        else:
            action = body.action
        return request.app.state.aging_runtime.start(action, config)
    except (AgingRuntimeError, AgingRecorderError, AgingLogError) as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )


@router.post("/api/aging/stop")
def post_aging_recording_stop(request: Request, body: ManualActionRequest):
    if body.confirm is not True:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "confirmation_required", "message": "用户确认是必需的"}},
        )
    try:
        return request.app.state.aging_runtime.request_stop()
    except (AgingRuntimeError, AgingRecorderError) as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )


@router.get("/api/aging/actions")
def get_aging_actions(request: Request) -> dict:
    """List the persisted backend action library (processed actions only)."""
    try:
        return {"actions": _aging_store(request).list_actions()}
    except AgingLogError as exc:
        return _aging_error(exc)


@router.post("/api/aging/actions")
def post_aging_action(request: Request, body: AgingActionRequest):
    """Persist one processed action to the backend action library.

    The action is validated with the exact same checks the aging runtime will
    apply before execution, so anything stored here can always be started.
    Persistence itself never schedules, validates, or moves a device.
    """
    try:
        AgingRuntime._validate(
            body.action,
            {"loop_mode": "count", "loop_count": 1, "interval_sec": 0},
        )
        saved = _aging_store(request).save_action(body.action)
        return {"action": saved}
    except AgingLogError as exc:
        return _aging_error(exc)
    except AgingRuntimeError as exc:
        return _aging_error(exc)


@router.delete("/api/aging/actions/{action_id:path}")
def delete_aging_action(request: Request, action_id: str) -> dict:
    """Remove one persisted action from the backend action library."""
    try:
        _aging_store(request).delete_action(action_id)
        return {"deleted": True}
    except AgingLogError as exc:
        return _aging_error(exc)


@router.get("/api/aging/logs/directories")
def get_aging_log_directories(request: Request, path: str = ""):
    """List immediate real subdirectories below the configured root."""

    try:
        return {
            "path": path,
            "directories": _aging_store(request).list_directories(path),
            "aging_execution_available": False,
        }
    except Exception as exc:
        from .aging_logs import AgingLogError

        if isinstance(exc, AgingLogError):
            return _aging_error(exc)
        raise


@router.post("/api/aging/logs/directories")
def post_aging_log_directory(request: Request, body: AgingDirectoryRequest):
    """Create a root-relative directory used for future log sessions."""

    path = body.directory if body.directory is not None else body.path
    try:
        created = _aging_store(request).create_directory(path)
        return {
            "path": created,
            "created": True,
            "aging_execution_available": False,
        }
    except Exception as exc:
        from .aging_logs import AgingLogError

        if isinstance(exc, AgingLogError):
            return _aging_error(exc)
        raise


@router.post("/api/aging/logs/sessions")
def post_aging_log_session(request: Request, body: AgingSessionCreateRequest):
    """Atomically create a file-only session bundle.

    This endpoint persists metadata and action documents only.  It never
    schedules, validates, or executes an aging action on a robot.
    """

    directory = body.path if body.path is not None else body.directory
    try:
        info = _aging_store(request).create_session(
            directory,
            session=body.session,
            raw_action=body.raw_action,
            processed_action=body.processed_action,
        )
        return {
            **info.to_dict(),
            "aging_execution_available": False,
            "message": "session files created; aging execution is not open",
        }
    except Exception as exc:
        from .aging_logs import AgingLogError

        if isinstance(exc, AgingLogError):
            return _aging_error(exc)
        raise


@router.put("/api/aging/logs/sessions/{session_path:path}/raw-action")
def put_aging_raw_action(
    request: Request, session_path: str, body: AgingJsonDocumentRequest
):
    try:
        _aging_store(request).write_session_json(session_path, "raw_action.json", body.payload)
        return {"path": session_path, "file": "raw_action.json", "persisted": True}
    except Exception as exc:
        from .aging_logs import AgingLogError

        if isinstance(exc, AgingLogError):
            return _aging_error(exc)
        raise


@router.put("/api/aging/logs/sessions/{session_path:path}/processed-action")
def put_aging_processed_action(
    request: Request, session_path: str, body: AgingJsonDocumentRequest
):
    try:
        _aging_store(request).write_session_json(
            session_path, "processed_action.json", body.payload
        )
        return {"path": session_path, "file": "processed_action.json", "persisted": True}
    except Exception as exc:
        from .aging_logs import AgingLogError

        if isinstance(exc, AgingLogError):
            return _aging_error(exc)
        raise


@router.post("/api/aging/logs/sessions/{session_path:path}/events")
def post_aging_event(
    request: Request, session_path: str, body: AgingEventRequest
):
    try:
        _aging_store(request).append_event(session_path, body.event)
        return {"path": session_path, "file": "events.jsonl", "appended": True}
    except Exception as exc:
        from .aging_logs import AgingLogError

        if isinstance(exc, AgingLogError):
            return _aging_error(exc)
        raise


@router.get("/api/health", response_model=HealthResponse)
def get_health(request: Request) -> dict:
    settings = request.app.state.settings
    state = request.app.state
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": __version__,
        "adapter": settings.adapter,
        "channel": settings.channel,
        # Populated at startup by the SDK gate (app.py); null in simulation.
        "motorbridge_version": getattr(state, "motorbridge_version", None),
        "motorbridge_abi_version": getattr(
            state, "motorbridge_abi_version", None
        ),
        # Established at startup (app.py); fail-closed defaults if absent.
        "capabilities": getattr(state, "capabilities", _SAFE_CAPABILITIES),
        "time": utc_now_iso(),
    }


@router.get("/api/robot/connection", response_model=RobotConnectionResponse)
def get_connection(request: Request) -> dict:
    """Return the latest complete scan result (never a guessed state)."""
    return _with_capabilities(request, request.app.state.service.snapshot())


@router.post("/api/robot/scan", response_model=RobotConnectionResponse)
def post_scan(request: Request):
    """Run a full read-only CAN scan (blocking until complete).

    Returns 409 when another scan is already in progress. The request body
    is intentionally ignored: expected IDs and channel are fixed server-side.
    """
    service = request.app.state.service
    try:
        return _with_capabilities(request, service.run_scan())
    except (ScanInProgressError, ZeroTorqueBusyError) as exc:
        return JSONResponse(
            status_code=409,
            content={
                "error": {
                    "code": "zero_torque_active" if isinstance(exc, ZeroTorqueBusyError) else "scan_in_progress",
                    "message": str(exc),
                }
            },
        )


@router.post("/api/robot/disconnect", response_model=RobotConnectionResponse)
def post_disconnect(request: Request) -> dict:
    """Clear service state / release adapter resources.

    Never sends disable or motion commands to the motors.
    """
    try:
        request.app.state.aging_recorder.stop()
        return _with_capabilities(request, request.app.state.service.disconnect())
    except ZeroTorqueBusyError as exc:
        return JSONResponse(
            status_code=409,
            content={"error": {"code": "zero_torque_active", "message": str(exc)}},
        )


def _manual_action(request: Request, action: str, body: ManualActionRequest):
    if body.confirm is not True:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "confirmation_required", "message": "用户确认是必需的；未触碰电机"}},
        )
    try:
        result = getattr(request.app.state.writes, action)()
    except WriteOpError as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )
    return result


@router.post("/api/robot/enable")
def post_enable(request: Request, body: ManualActionRequest):
    """User-confirmed enable_all on the shared connected Controller only."""
    return _manual_action(request, "enable_all", body)


@router.post("/api/robot/disable")
def post_disable(request: Request, body: ManualActionRequest):
    """User-confirmed disable_all on the shared connected Controller only."""
    return _manual_action(request, "disable_all", body)


@router.get("/api/robot/zero-torque/status")
def get_zero_torque_status(request: Request) -> dict:
    """Return backend-owned zero-torque state without touching the bus."""
    return request.app.state.writes.zero_torque_status()


@router.post("/api/robot/zero-torque/start")
def post_zero_torque_start(request: Request, body: ManualActionRequest):
    if body.confirm is not True:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "confirmation_required", "message": "用户确认是必需的；未触碰电机"}},
        )
    try:
        return request.app.state.writes.start_zero_torque()
    except WriteOpError as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )


@router.post("/api/robot/zero-torque/stop")
def post_zero_torque_stop(request: Request, body: ManualActionRequest):
    if body.confirm is not True:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "confirmation_required", "message": "用户确认是必需的；未触碰电机"}},
        )
    try:
        return request.app.state.writes.stop_zero_torque()
    except WriteOpError as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )


@router.post("/api/robot/parameters/gains")
def post_persistent_gains(request: Request, body: PersistentGainsRequest):
    """Write only verified persistent LocKp/SpdKp f32 parameters.

    The legacy KP/KD labels are mapped to position-loop KP (0x701E) and
    speed-loop KP (0x701F). This endpoint never calls send_mit and is not an
    MIT-gain or zero-torque operation.
    """
    if body.confirm is not True:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "confirmation_required", "message": "用户确认是必需的；未触碰电机"}},
        )
    try:
        return request.app.state.writes.write_persistent_gains(body.changes)
    except WriteOpError as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )


@router.post("/api/robot/parameters/zero")
def post_mechanical_zero(request: Request, body: ManualActionRequest):
    """Apply the user-confirmed rs_tools.py mechanical-zero sequence."""
    if body.confirm is not True:
        return JSONResponse(
            status_code=400,
            content={"error": {"code": "confirmation_required", "message": "用户确认是必须的；未触碰电机"}},
        )
    try:
        return request.app.state.writes.set_zero()
    except WriteOpError as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": str(exc)}},
        )


@router.websocket("/ws/robot/telemetry")
async def telemetry_websocket(websocket: WebSocket) -> None:
    """Joint telemetry stream (one JSON frame per tick).

    Simulation mode streams deterministic frames at ``settings.telemetry_hz``
    with a bounded keep-latest queue for slow clients; the stream stops when
    the client disconnects or the service generation is invalidated.

    Motorbridge mode streams REAL RobStride state via the active-report
    session (``activereport.py``) — the ONLY authorized motor write
    (``robstride_set_active_report`` True/False), gated behind
    ``REBOT_ALLOW_ACTIVE_REPORT_WRITE=1``, a verified 0.5.1 SDK, a fully
    successful scan (all IDs 1..7) and at least one subscriber. Without the
    authorization flag the endpoint rejects the connection without touching
    any motor.
    """
    settings = websocket.app.state.settings
    await websocket.accept()
    if settings.adapter == ADAPTER_SIMULATION:
        await stream_simulation_telemetry(
            websocket, websocket.app.state.service, settings
        )
    else:
        await websocket.app.state.telemetry_hub.subscribe(websocket)
