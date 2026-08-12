"""RobStride active-report telemetry — the ONLY authorized motor write.

Phase 5 authorization (explicit and narrow)
-------------------------------------------
The user authorized exactly two motorbridge 0.5.1 calls for this service:

* ``robstride_set_active_report(True)``  — once per motor (IDs 1..7) when a
  telemetry session starts;
* ``robstride_set_active_report(False)`` — on cleanup: session stop,
  partial-enable rollback, robot disconnect, service shutdown.

Every other write remains forbidden
(``scanners/motorbridge.FORBIDDEN_SDK_CALLS``). Nothing in this module may
call anything outside the session lifecycle documented below.

Source evidence (motorbridge 0.4.9 sdist, re-verified byte-for-byte for the
pinned 0.5.1 via sdist diff — Phase 7B)
-----------------------------------------
* ``core.py``: ``robstride_set_active_report(self, enabled: bool) -> None``
  forwards ``1 if enabled else 0`` to the native
  ``motor_handle_robstride_set_active_report``. The ONLY parameter is a
  boolean — there is no position/velocity/torque/zero/KP/KD/mode argument
  in the signature, so this call cannot command motion, change gains, or
  enable the motor. Return value: ``None`` (native failures raise).
* README ("RobStride maintenance notes"): ``robstride_set_active_report``
  "toggles RobStride comm_type 24 active status reporting. With active
  reporting on, background polling can update ``get_state()`` from incoming
  status frames without new query commands." — it configures status
  *reporting* (a communication type), it is not a control mode.
* The vendor CLI treats ``active-report`` as a maintenance mode
  (``--active-report 1/0``), separate from enable/disable and motion modes.
* README: ``request_feedback()`` is a non-blocking no-op for RobStride —
  this module never calls it and never fabricates its (absent) result.
* Official flow after enabling: ``Controller.poll_feedback_once()`` keeps
  receiving status frames; ``Motor.get_state()`` (a pure getter) returns
  the latest one (``None`` while no frame has arrived — reported as null).
* Units from vendor sources: position rad, velocity rad/s (``cli/scan.py``:
  ``angle={st.pos:+.3f}rad``, ``vel={st.vel:+.3f}rad/s``; README:
  ``send_pos_vel(3.1416, 2.0)  # rad / rad/s``), torque Nm (``torq=…Nm``),
  temperature °C (``temp={st.t_mos:.1f}C``) — see ``telemetry.UNITS``.
* ``MotorState`` fields: ``can_id, arbitration_id, status_code, pos, vel,
  torq, t_mos, t_rotor`` — no current field, no separate error field, so
  those telemetry fields are always ``null`` (never fabricated).

Residual risk (documented, not acted on): the vendor's bring-up example
pairs the toggle with a ``write-param 0x7026 u16 3`` step. That parameter
write is NOT authorized and is never performed; if a motor firmware
required it, joints simply stay null/"none" — no data is fabricated.

Session lifecycle (call ordering)
---------------------------------
start : ``Controller(channel)`` -> ``add_robstride_motor(mid, host_id,
        model)`` for IDs 1..7 -> ``robstride_set_active_report(True)`` once
        per motor (the ONLY write). ANY failure after the first enable
        rolls back every successfully enabled motor with
        ``robstride_set_active_report(False)``, releases all handles, and
        fails closed — a partial session never emits frames.
run   : a background thread calls ``poll_feedback_once()`` at ~2 ms cadence
        so incoming status frames update motor state; the frame builder
        reads ``get_state()`` per motor under a shared lock (serializes
        native-handle access between the poll thread and frame building).
stop  : request poll-thread exit and JOIN it (bounded wait) -> ONLY once the
        thread is confirmed dead: ``robstride_set_active_report(False)`` for
        every still-enabled motor (communication may already be gone —
        failures are logged only; NO other control method is ever called
        during cleanup) -> audited read-only release under the handle lock:
        ``motor.close()`` for each handle, ``close_bus()`` (motors were
        bound), ``Controller.close()`` — the vendor scan CLI pattern, never
        ``shutdown()``. If the poll thread does not exit within the join
        timeout, stop FAILS CLOSED: it disables nothing and releases
        nothing (a still-running thread may still use the controller —
        leaking handles is safer than a use-after-free in the native
        layer) and reports the incomplete teardown. Repeated ``stop()``
        calls stay fail closed in that case; the only recovery is a
        service restart.

Hub gates (ALL must hold before any motor is written to)
--------------------------------------------------------
1. ``REBOT_ALLOW_ACTIVE_REPORT_WRITE=1`` (default OFF);
2. ``REBOT_ADAPTER=motorbridge`` and the SDK verifies as exactly 0.5.1
   (re-checked at session start via ``sdkcheck``);
3. the latest completed scan reports ``connected`` (ALL IDs 1..7 found);
4. at least one WebSocket subscriber (first subscriber starts the session,
   last subscriber leaving stops it).

No real CAN is connected in development or tests: the SDK module is always
a recording fake injected into ``sys.modules``.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Dict, Optional

from .models import STATUS_CONNECTED, utc_now_iso
from .scanners.motorbridge import MOTOR_MODELS
from .sdkcheck import REQUIRED_MOTORBRIDGE_VERSION, import_verified_sdk
from .service import BusBusyError, ScanInProgressError
from .telemetry import SOURCE_MOTORBRIDGE, UNITS, joint_from_motor_state, put_latest

logger = logging.getLogger(__name__)

#: Background polling cadence while a session is live.
POLL_PERIOD_S = 0.002
_POLL_JOIN_TIMEOUT_S = 2.0
_POLL_WARN_EVERY = 1000
_MESSAGE_LIMIT = 300
# A receive-side glitch is a stale-data condition, not a session teardown.
# Keep this finite so a genuinely dead controller still fails closed.
TELEMETRY_READ_FAILURE_THRESHOLD = 5


def _sanitize(message: object) -> str:
    """Collapse whitespace and truncate — keeps messages clean."""
    return " ".join(str(message).split())[:_MESSAGE_LIMIT]


class TelemetrySessionError(RuntimeError):
    """The session could not start; enabled motors were rolled back and all
    handles released (fail closed)."""


class TelemetryReadFailure(RuntimeError):
    """The shared receive path exceeded its bounded consecutive failure limit."""


class ActiveReportSession:
    """Owns one Controller + motor handles while streaming real telemetry.

    Only ``activereport.MotorbridgeTelemetryHub`` may construct this, and
    only after every authorization gate passed. The write surface is exactly
    ``robstride_set_active_report(True)`` once per motor at start and
    ``robstride_set_active_report(False)`` per enabled motor at stop or
    rollback — nothing else, ever.
    """

    def __init__(
        self,
        module: Any,
        channel: str,
        host_id: int,
        expected_ids,
    ) -> None:
        self._module = module
        self._channel = channel
        self._host_id = host_id
        self._expected_ids = tuple(sorted(expected_ids))
        self._controller: Any = None
        self._motors: Dict[int, Any] = {}
        self._enabled: list = []
        # Serializes native-handle access between the poll thread and
        # frame building (get_state).
        self._lock = threading.Lock()
        self._poll_stop = threading.Event()
        self._poll_thread: Optional[threading.Thread] = None
        self._poll_failures = 0
        self._poll_failed_closed = threading.Event()
        # stop() bookkeeping. ``_stopped`` makes stop idempotent; ``_stop_failed``
        # records a fail-closed teardown (poll thread never confirmed dead), in
        # which case resources were intentionally NOT released and must never be
        # released by a later stop() either.
        self._stopped = False
        self._stop_failed = False

    # ---- lifecycle ------------------------------------------------------

    def start(self) -> None:
        """Open the controller, register IDs 1..7, enable active reporting.

        Call ordering: Controller(channel) -> add_robstride_motor x N ->
        robstride_set_active_report(True) once per motor -> start the
        background poll thread. Any failure after the first enable rolls
        back all successfully enabled motors and releases everything.
        """
        # Version gate (defense in depth): only the audited release may
        # receive the authorized write.
        version = getattr(self._module, "__version__", None)
        if version != REQUIRED_MOTORBRIDGE_VERSION:
            raise TelemetrySessionError(
                f"unsupported motorbridge version {version!r}; required "
                f"{REQUIRED_MOTORBRIDGE_VERSION} (fail closed)"
            )

        try:
            self._controller = self._module.Controller(self._channel)
        except Exception as exc:
            raise TelemetrySessionError(
                f"cannot open controller on {self._channel}: "
                f"{type(exc).__name__}: {_sanitize(exc)}"
            ) from None

        try:
            for motor_id in self._expected_ids:
                model = MOTOR_MODELS.get(motor_id)
                if model is None:
                    raise ValueError(
                        f"no motor model configured for id {motor_id}"
                    )
                self._motors[motor_id] = self._controller.add_robstride_motor(
                    motor_id, self._host_id, model
                )
            for motor_id in self._expected_ids:
                # The single authorized write — exactly once per motor.
                self._motors[motor_id].robstride_set_active_report(True)
                self._enabled.append(motor_id)
        except Exception as exc:
            # Partial-enable rule: roll back every successfully enabled
            # motor, release all handles, fail closed. No session, no
            # frames — incomplete data is never output as normal telemetry.
            self._disable_enabled(
                context="rollback",
                note="enabled motors rolled back to False and all handles released",
            )
            self._release_best_effort()
            raise TelemetrySessionError(
                f"active-report enable failed: {type(exc).__name__}: "
                f"{_sanitize(exc)}; successfully enabled motors were rolled "
                "back to False and all handles released"
            ) from None

        self._poll_stop.clear()
        self._poll_failures = 0
        self._poll_failed_closed.clear()
        self._poll_thread = threading.Thread(
            target=self._poll_loop,
            name="rebot-telemetry-poll",
            daemon=True,
        )
        self._poll_thread.start()
        logger.info(
            "active-report session started",
            extra={
                "channel": self._channel,
                "motor_ids": list(self._enabled),
                "sdk_version": version,
            },
        )

    def stop(self) -> bool:
        """Tear down: confirm poll thread dead -> authorized disable -> release.

        Ordering is a safety requirement, not an optimization:

        1. signal the poll thread to exit and ``join`` it with a bounded
           timeout;
        2. ONLY once the thread is confirmed dead, disable active reporting
           and release the handles — and do it under ``self._lock`` so a
           ``build_frame``/``get_state`` call still in flight on another
           executor thread completes first and can never touch a handle we
           are closing.

        If the thread does NOT exit within the join timeout we fail closed:
        a still-running thread may still be inside the native controller, so
        disabling motors / closing handles would risk a use-after-free. In
        that case we release *nothing*, mark ``_stop_failed`` and return
        ``False``. Repeated ``stop()`` calls then keep returning ``False``
        without touching the resources — the only recovery is a service
        restart.

        Returns ``True`` when teardown completed and resources were released,
        ``False`` when it failed closed. ``stop()`` is idempotent.
        """
        # Repeated stop(): report the previous outcome and touch nothing.
        if self._stopped:
            return not self._stop_failed

        self._poll_stop.set()
        thread, self._poll_thread = self._poll_thread, None
        if thread is not None and thread.is_alive():
            thread.join(timeout=_POLL_JOIN_TIMEOUT_S)

        if thread is not None and thread.is_alive():
            # The poll thread survived the bounded join. It may still hold the
            # lock and be inside the native controller, so releasing anything
            # now could free a handle out from under it. Fail closed.
            self._stop_failed = True
            self._stopped = True
            logger.error(
                "active-report poll thread did not exit within %.1fs; failing "
                "closed: motors NOT disabled and handles NOT released (they "
                "may still be in use). Service restart required.",
                _POLL_JOIN_TIMEOUT_S,
                extra={"channel": self._channel},
            )
            return False

        # Thread confirmed dead (or never started): release under the lock so
        # any concurrent build_frame/get_state quiesces before we close.
        with self._lock:
            self._disable_enabled(
                context="stop",
                note=(
                    "active reporting disabled on enabled motors; read-only "
                    "release follows"
                ),
            )
            self._release_best_effort()
        self._stopped = True
        logger.info(
            "active-report session stopped",
            extra={"channel": self._channel},
        )
        return True

    # ---- frame building ---------------------------------------------------

    def build_frame(self, sequence: int) -> Dict[str, Any]:
        """One telemetry frame from the latest ``get_state()`` per motor.

        Motors without a received status frame are reported all-null with
        freshness ``none`` — never fabricated. Units are explicit per frame
        (rad / rad/s / Nm / degC, confirmed from the 0.5.1 sources).
        """
        if self._poll_failed_closed.is_set():
            raise TelemetryReadFailure(
                "poll_feedback_once exceeded the consecutive failure threshold"
            )
        joints = []
        with self._lock:
            for motor_id in self._expected_ids:
                joints.append(self._joint(motor_id))
        return {
            "timestamp": utc_now_iso(),
            "sequence": sequence,
            "channel": self._channel,
            "source": SOURCE_MOTORBRIDGE,
            "units": dict(UNITS),
            "joints": joints,
        }

    def _joint(self, motor_id: int) -> Dict[str, Any]:
        motor = self._motors.get(motor_id)
        state = None
        if motor is not None:
            try:
                state = motor.get_state()
            except Exception as exc:
                logger.warning(
                    "get_state failed for motor %s (reported as null): %s: %s",
                    motor_id,
                    type(exc).__name__,
                    _sanitize(exc),
                )
        return joint_from_motor_state(motor_id, state)

    # ---- internals ---------------------------------------------------------

    def _poll_loop(self) -> None:
        """Official post-enable flow: poll_feedback_once() keeps receiving
        the actively reported status frames so get_state() stays current."""
        while not self._poll_stop.wait(POLL_PERIOD_S):
            try:
                with self._lock:
                    if self._controller is not None:
                        self._controller.poll_feedback_once()
                self._poll_failures = 0
            except Exception as exc:
                # Keep the session alive; get_state decides null-ness, so no
                # data is ever fabricated. Log sparingly (2 ms cadence).
                self._poll_failures += 1
                if self._poll_failures in (1, _POLL_WARN_EVERY):
                    logger.warning(
                        "poll_feedback_once failed (session continues, "
                        "state may go stale): %s: %s",
                        type(exc).__name__,
                        _sanitize(exc),
                    )
                if self._poll_failures >= TELEMETRY_READ_FAILURE_THRESHOLD:
                    self._poll_failed_closed.set()
                    self._poll_stop.set()
                    logger.error(
                        "poll_feedback_once failed %d consecutive times; "
                        "telemetry session will fail closed",
                        self._poll_failures,
                    )

    def _disable_enabled(self, context: str, note: str) -> None:
        """The authorized cleanup write: ``robstride_set_active_report(False)``
        for every still-enabled motor.

        Communication may already be gone (robot disconnect, bus error) —
        failures are logged only and never retried with other methods: NO
        other control call (enable/disable/motion/mode/param/clear-error)
        is permitted during cleanup.
        """
        for motor_id in list(self._enabled):
            motor = self._motors.get(motor_id)
            if motor is None:
                continue
            try:
                motor.robstride_set_active_report(False)
            except Exception as exc:
                logger.warning(
                    "active-report disable (%s) failed for motor %s "
                    "(ignored; no other control call is permitted): %s: %s",
                    context,
                    motor_id,
                    type(exc).__name__,
                    _sanitize(exc),
                )
        if self._enabled:
            logger.info(
                "active-report disabled (%s) on %d motor(s): %s",
                context,
                len(self._enabled),
                note,
            )
        self._enabled = []

    def _release_best_effort(self) -> None:
        """Audited read-only release (vendor scan CLI pattern):
        ``motor.close()`` per handle, ``close_bus()`` when motors were
        bound, then ``Controller.close()``. Never ``shutdown()`` — every
        step logs and continues on failure."""
        for motor_id in sorted(self._motors):
            close = getattr(self._motors[motor_id], "close", None)
            if callable(close):
                try:
                    close()
                except Exception as exc:
                    logger.warning(
                        "motor %s close failed (ignored): %s: %s",
                        motor_id,
                        type(exc).__name__,
                        _sanitize(exc),
                    )
        bound = bool(self._motors)
        self._motors = {}
        controller, self._controller = self._controller, None
        if controller is None:
            return
        if bound:
            close_bus = getattr(controller, "close_bus", None)
            if callable(close_bus):
                try:
                    close_bus()
                except Exception as exc:
                    logger.warning(
                        "controller close_bus failed (ignored): %s: %s",
                        type(exc).__name__,
                        _sanitize(exc),
                    )
        close = getattr(controller, "close", None)
        if callable(close):
            try:
                close()
            except Exception as exc:
                logger.warning(
                    "controller close failed (ignored): %s: %s",
                    type(exc).__name__,
                    _sanitize(exc),
                )


class SharedActiveReportSession:
    """Read-only view over the Controller already owned by ScanService.

    Connection scanning performs the one-time active-report configuration.
    This session never configures, enables, disables, or opens a Controller;
    it only receives/parses feedback through the shared owner.
    """

    def __init__(self, service) -> None:
        self._service = service
        self._consecutive_failures = 0

    def start(self) -> None:
        return None

    def stop(self) -> bool:
        # The connection owns active-report lifetime; disconnect releases it.
        return True

    def build_frame(self, sequence: int) -> Optional[Dict[str, Any]]:
        """Read one frame, treating short receive failures as no new frame.

        The scan-owned Controller remains untouched.  Until the bounded limit
        is reached, callers receive ``None`` so the client can mark its last
        valid frame stale while keeping the shared WebSocket alive.

        Bus contention (a scan, a gated write, or the aging setup/motion hold)
        is NORMAL concurrency, not a telemetry defect: it is reset and reported
        as ``None`` so the emit loop never fail-closes the session just because
        another operation briefly owns the shared Controller.
        """
        try:
            frame = self._service.read_telemetry(sequence)
        except (BusBusyError, ScanInProgressError):
            # Another operation (scan / write / aging) owns the bus briefly.
            # This is not a receive failure and must not count toward the
            # fail-closed threshold.
            self._consecutive_failures = 0
            return None
        except Exception as exc:
            self._consecutive_failures += 1
            if self._consecutive_failures in (
                1,
                TELEMETRY_READ_FAILURE_THRESHOLD,
            ):
                logger.warning(
                    "telemetry read failed %d consecutive time(s); no new "
                    "frame published: %s: %s",
                    self._consecutive_failures,
                    type(exc).__name__,
                    _sanitize(exc),
                )
            if self._consecutive_failures >= TELEMETRY_READ_FAILURE_THRESHOLD:
                raise TelemetryReadFailure(
                    "telemetry read exceeded the consecutive failure threshold"
                ) from exc
            return None
        if frame is None:
            self._consecutive_failures = 0
            return None
        self._consecutive_failures = 0
        return frame


async def _reject(websocket, code: str, message: str) -> None:
    """Send one sanitized error frame and close (fail closed)."""
    try:
        await websocket.send_json({"error": {"code": code, "message": message}})
    except Exception:
        pass
    try:
        # 1011 = server-side failure; 1008 = policy (not authorized /
        # preconditions not met).
        await websocket.close(code=1011 if code == "telemetry_error" else 1008)
    except Exception:
        pass


class MotorbridgeTelemetryHub:
    """Subscriber-counted owner of the shared active-report session.

    The first subscriber starts the session (only when every gate holds);
    the last subscriber leaving stops it (authorized disable + audited
    release). A bumped service generation (``POST /api/robot/disconnect``)
    invalidates every stream, which also tears the session down. Service
    shutdown stops it via :meth:`shutdown`.

    Each subscriber gets a bounded ``asyncio.Queue(maxsize=1)`` fed by the
    shared emitter via ``put_latest`` — slow clients drop intermediate
    frames and always see the newest one.
    """

    def __init__(self, settings, service, module_name: str = "motorbridge", frame_sink=None) -> None:
        self._settings = settings
        self._service = service
        self._module_name = module_name
        self._session: Optional[ActiveReportSession] = None
        self._emitter: Optional[asyncio.Task] = None
        self._clients: set = set()
        self._lock = asyncio.Lock()
        self._sequence = 0
        self._session_generation: Optional[int] = None
        # Optional non-blocking observer of the exact frame already sent to
        # WebSocket clients. It must never read CAN or await disk I/O.
        self._frame_sink = frame_sink

    # ---- public API -------------------------------------------------------

    async def subscribe(self, websocket) -> None:
        """Serve one telemetry client; returns when the client must stop."""
        # Gate 1: explicit authorization flag (default OFF).
        if not self._settings.allow_active_report_write:
            await _reject(
                websocket,
                "telemetry_not_allowed",
                "active-report telemetry is disabled by configuration: "
                "robstride_set_active_report is only called when "
                "REBOT_ALLOW_ACTIVE_REPORT_WRITE=1 (default 0). No motor "
                "was touched.",
            )
            return
        # Gate 2: the latest completed scan must be fully connected —
        # every expected motor ID (1..7) responded.
        snapshot = self._service.snapshot()
        if snapshot.get("status") != STATUS_CONNECTED:
            await _reject(
                websocket,
                "telemetry_requires_connected",
                "telemetry requires a successful full scan first: the last "
                f"scan status is {snapshot.get('status')!r}, expected "
                "'connected' (all motor IDs 1-7 responded). No motor was "
                "touched.",
            )
            return

        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        start_error: Optional[str] = None
        async with self._lock:
            self._clients.add(queue)
            if self._session is None:
                try:
                    await self._start_session_locked()
                except Exception as exc:
                    # start() already rolled back and released on failure;
                    # nothing was left half-enabled.
                    start_error = _sanitize(exc)
                    self._clients.discard(queue)
        if start_error is not None:
            await _reject(
                websocket,
                "telemetry_error",
                f"telemetry session start failed: {start_error}",
            )
            return

        try:
            await self._stream(websocket, queue)
        finally:
            # Cleanup must run to completion even when this task is
            # cancelled (server shutdown, or test clients that cancel the
            # connection task immediately after the client disconnects):
            # shield it. Without cancellation this simply awaits the
            # cleanup; under cancellation the shielded task keeps running
            # on the event loop, so the authorized disable + audited
            # release are never skipped or half-done.
            cleanup = asyncio.ensure_future(self._cleanup(queue, websocket))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("telemetry cleanup failed")

    async def _cleanup(self, queue: asyncio.Queue, websocket) -> None:
        try:
            await self._unsubscribe(queue)
        finally:
            # Close handshake only AFTER cleanup: the peer must never see
            # the connection end before the authorized disable + audited
            # release have completed.
            try:
                await websocket.close(code=1000)
            except Exception:
                pass

    async def shutdown(self) -> None:
        """Service stop: stop the session (authorized cleanup + release)."""
        async with self._lock:
            await self._stop_session_locked()

    # ---- internals ----------------------------------------------------------

    async def _start_session_locked(self) -> None:
        if callable(getattr(self._service, "read_telemetry", None)):
            # Production path: scan already created the one persistent owner
            # and configured active reporting. No second Controller here.
            session = SharedActiveReportSession(self._service)
            self._session = session
            self._session_generation = self._service.generation
            self._sequence = 0
            self._emitter = asyncio.ensure_future(self._emit_loop())
            logger.info(
                "telemetry hub: shared active-report receive session started",
                extra={"generation": self._session_generation},
            )
            return
        # Re-verify the SDK at session start (defense in depth: the startup
        # gate in app.py ran when the app was created). Raises ConfigError
        # unless the SDK is exactly 0.5.1.
        module = import_verified_sdk(self._module_name)
        session = ActiveReportSession(
            module,
            self._settings.channel,
            self._settings.host_id,
            self._settings.expected_ids,
        )
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, session.start)
        # Only after start() succeeded is the session live — a failed start
        # already rolled back and released everything itself.
        self._session = session
        self._session_generation = self._service.generation
        self._sequence = 0
        self._emitter = asyncio.ensure_future(self._emit_loop())
        logger.info(
            "telemetry hub: session started",
            extra={
                "channel": self._settings.channel,
                "expected_ids": list(self._settings.expected_ids),
                "generation": self._session_generation,
            },
        )

    async def _stop_session_locked(self) -> None:
        emitter, self._emitter = self._emitter, None
        if emitter is not None:
            emitter.cancel()
            try:
                await emitter
            except (asyncio.CancelledError, Exception):
                pass
        session, self._session = self._session, None
        if session is not None:
            loop = asyncio.get_running_loop()
            # Authorized cleanup: robstride_set_active_report(False) per
            # enabled motor (failures logged only), then audited read-only
            # release. No other control method is called. stop() only runs
            # the release after the poll thread is confirmed dead; if the
            # thread survives the bounded join it fails closed and returns
            # False without releasing anything.
            released = await loop.run_in_executor(None, session.stop)
            if released:
                logger.info("telemetry hub: session stopped and released")
            else:
                logger.error(
                    "telemetry hub: session stop FAILED CLOSED; poll thread "
                    "did not exit, motors not disabled and handles not "
                    "released (they may still be in use)"
                )

    async def _emit_loop(self) -> None:
        """Publish frames to every subscriber's bounded queue at
        ``settings.telemetry_hz``; slow clients drop intermediate frames."""
        period = 1.0 / self._settings.telemetry_hz
        loop = asyncio.get_running_loop()
        consecutive_failures = 0
        try:
            while True:
                session = self._session
                if session is None:
                    return
                next_sequence = self._sequence + 1
                frame = await loop.run_in_executor(
                    None, session.build_frame, next_sequence
                )
                if frame is None:
                    # A None frame means the shared bus was owned by another
                    # operation (aging setup/motion, write, scan) at that
                    # instant — normal contention, not a telemetry defect.
                    # Do not advance sequence and never fail-closed on it; a
                    # real read error is raised by build_frame instead.
                    await asyncio.sleep(period)
                    continue
                consecutive_failures = 0
                self._sequence = next_sequence
                if self._frame_sink is not None:
                    try:
                        self._frame_sink(frame)
                    except Exception:
                        # Logging is an observer. A recorder defect must be
                        # visible in its own status but must not tear down live
                        # telemetry or freeze the 3D model.
                        logger.exception("telemetry frame sink failed")
                for queue in list(self._clients):
                    await put_latest(queue, frame)
                await asyncio.sleep(period)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "telemetry emitter failed; stopping the session (fail closed)"
            )
            asyncio.ensure_future(self._stop_after_failure())

    async def _stop_after_failure(self) -> None:
        async with self._lock:
            await self._stop_session_locked()

    async def _stream(self, websocket, queue: asyncio.Queue) -> None:
        """Consume this client's queue until disconnect / generation
        invalidation / session stop."""
        stop = asyncio.Event()

        async def watch_client() -> None:
            try:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
            except Exception:
                # Any receive error means the peer is gone.
                pass
            stop.set()

        watcher = asyncio.create_task(watch_client())
        start_generation = self._session_generation
        try:
            while not stop.is_set():
                if self._service.generation != start_generation:
                    # Safety generation invalidated (robot disconnect):
                    # stop streaming immediately — cleanup happens in
                    # _unsubscribe when the last client has left.
                    break
                if self._session is None:
                    # Session stopped (failed or torn down): no stale data.
                    break
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=0.25)
                except asyncio.TimeoutError:
                    continue
                try:
                    await websocket.send_json(frame)
                except Exception:
                    # The peer is gone: a disconnect can race an in-flight
                    # send (observed in Phase 7G real-hardware integration:
                    # starlette raises WebSocketDisconnect from send_json).
                    # Treat any send failure as a normal end of stream —
                    # subscribe()'s finally still runs the complete
                    # authorized cleanup. Never let teardown noise escape
                    # to the ASGI layer as an unhandled exception.
                    break
        finally:
            stop.set()
            watcher.cancel()
            try:
                await watcher
            except (asyncio.CancelledError, Exception):
                pass
            # NB: the close handshake happens in subscribe() AFTER cleanup.

    async def _unsubscribe(self, queue: asyncio.Queue) -> None:
        async with self._lock:
            self._clients.discard(queue)
            if not self._clients:
                # Last telemetry client gone: authorized cleanup writes and
                # audited release (also covers the generation-invalidated
                # path, which ends here for its last client too).
                await self._stop_session_locked()
