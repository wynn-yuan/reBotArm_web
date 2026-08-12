"""Connection-state service.

Single owner of scan execution and connection state. Guarantees:

* At most one scan at a time — a second attempt raises
  :class:`ScanInProgressError` (mapped to HTTP 409).
* Scans and Phase 7I gated write operations (``writes.py``) share ONE bus
  lock and never overlap: a scan requested while a write holds the bus
  raises :class:`BusBusyError` (HTTP 409), and a write requested while a
  scan runs gets :class:`ScanInProgressError` from the same lock.
* ``status`` only ever reflects the latest *completed* scan. It is never
  optimistically promoted to ``connected``: that requires every expected
  motor ID (1..7) to have responded; anything less stays ``partial``.
* Adapter exceptions never leak stack traces to the API.
* ``disconnect`` only clears service state / releases adapter resources.
  It never sends disable or motion commands to the motors.
* Scan generations: every ``disconnect`` bumps a generation counter under
  the state lock. A scan records the generation it started under; when it
  completes it only writes its result if the generation is unchanged.
  Results of scans overtaken by a ``disconnect`` are discarded, so a stale
  in-flight scan can never resurrect ``connected``/``partial`` after the
  client disconnected.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Sequence

from .config import validate_channel
from .models import (
    EXPECTED_MOTOR_IDS,
    STATUS_CONNECTED,
    STATUS_DISCONNECTED,
    STATUS_ERROR,
    STATUS_PARTIAL,
    STATUS_SCANNING,
    ScanOutcome,
    ScanState,
    utc_now_iso,
)


from .scanners.base import CanScanner

logger = logging.getLogger(__name__)

_MESSAGE_LIMIT = 300
# Telemetry shares the single native Controller with the 50 Hz zero-torque
# keepalive. A non-blocking acquire makes their fixed cadences phase-lock:
# telemetry can lose five consecutive 10 Hz reads and tear down the WebSocket
# even though the bus is healthy. Wait briefly for the current short SDK call
# instead. Long scans/writes still exceed this bound and fail closed.
_TELEMETRY_BUS_WAIT_S = 0.05


class ScanInProgressError(RuntimeError):
    """A scan was requested while another one is still running."""


class BusBusyError(RuntimeError):
    """A scan was requested while a gated write operation holds the bus."""


class ServiceOperationError(RuntimeError):
    """A shared-controller operation failed; callers must fail closed."""


class ZeroTorqueBusyError(RuntimeError):
    """The backend-owned zero-torque state machine owns the bus."""


class AgingBusyError(BusBusyError):
    """The backend-owned aging state machine owns motion control."""


def _format_ids(ids: Sequence[int]) -> str:
    return ", ".join(str(i) for i in ids)


def _sanitize(message: object) -> str:
    return " ".join(str(message).split())[:_MESSAGE_LIMIT]


class ScanService:
    """Runs scans serially and owns the connection-state snapshot."""

    def __init__(
        self,
        scanner: CanScanner,
        channel: str,
        expected_ids: Sequence[int] = EXPECTED_MOTOR_IDS,
        zero_torque_hz: float = 50.0,
    ) -> None:
        self._channel = validate_channel(channel)
        self._expected_ids = tuple(expected_ids)
        self._scanner = scanner
        self._state_lock = threading.Lock()
        self._scan_lock = threading.Lock()
        # Diagnostic owner of ``_scan_lock`` ("scan" or "write"); read only
        # to choose between ScanInProgressError and BusBusyError when an
        # acquire fails. Never used for synchronization itself.
        self._bus_owner: str = ""
        # Monotonic scan-generation counter. disconnect() bumps it so any
        # scan already in flight becomes stale and its result is discarded.
        self._generation = 0
        self._release_pending = False
        self._zero_torque_hz = max(1.0, min(50.0, float(zero_torque_hz)))
        self._zero_state_lock = threading.RLock()
        self._zero_lifecycle_lock = threading.Lock()
        self._zero_stop = threading.Event()
        self._zero_thread: threading.Thread | None = None
        self._zero_cleanup_done = True
        self._zero_cleanup_lock = threading.Lock()
        self._zero_status: Dict[str, Any] = {
            "status": "inactive",
            "frequency_hz": self._zero_torque_hz,
            "channel": self._channel,
            "motor_ids": list(self._expected_ids),
            "started_at": None,
            "updated_at": utc_now_iso(),
            "error": None,
        }
        self._aging_state_lock = threading.RLock()
        self._aging_motion_active = False
        self._state = ScanState(
            status=STATUS_DISCONNECTED,
            channel=self._channel,
            expected_ids=self._expected_ids,
            found_ids=(),
            missing_ids=(),
            started_at=None,
            completed_at=None,
            source=None,
            message="No scan has been performed yet",
        )

    @property
    def channel(self) -> str:
        return self._channel

    @property
    def expected_ids(self) -> tuple[int, ...]:
        return self._expected_ids

    @property
    def generation(self) -> int:
        """Current scan generation.

        Every ``disconnect`` bumps it; long-lived consumers (e.g. the
        telemetry WebSocket) capture it at start and must stop as soon as
        it changes — their session was invalidated.
        """
        with self._state_lock:
            return self._generation

    def snapshot(self) -> Dict[str, Any]:
        """Return a copy of the current connection state (the last result)."""
        with self._state_lock:
            return self._state.to_dict()

    def run_scan(self) -> Dict[str, Any]:
        """Run a full serial scan; raises ScanInProgressError when busy."""
        self.try_acquire_bus("scan")
        try:
            return self._run_scan_locked()
        finally:
            self.release_bus()
            self._release_if_pending()

    def run_manual_action(self, action: str) -> Dict[str, Any]:
        """Run exactly one controller-level manual action on the shared owner."""
        if action not in {"enable_all", "disable_all"}:
            raise ServiceOperationError("unsupported manual action")
        self.try_acquire_bus("write")
        try:
            method = getattr(self._scanner, action, None)
            if not callable(method):
                raise ServiceOperationError(
                    f"scanner does not expose shared-controller {action}"
                )
            try:
                method()
            except Exception as exc:
                raise ServiceOperationError(
                    f"{action} failed: {type(exc).__name__}: {_sanitize(exc)}"
                ) from None
            return {
                "ok": True,
                "operation": action,
                "channel": self._channel,
                "motor_ids": list(self._expected_ids),
                "completed_at": utc_now_iso(),
            }
        finally:
            self.release_bus()
            self._release_if_pending()

    def run_parameter_write(self, changes: Sequence[Dict[str, float]]) -> Dict[str, Any]:
        """Write verified persistent RobStride gains through the shared owner."""
        self.try_acquire_bus("write")
        try:
            method = getattr(self._scanner, "write_persistent_gains", None)
            if not callable(method):
                raise ServiceOperationError("persistent parameter owner is not available")
            try:
                result = method(changes)
            except Exception as exc:
                raise ServiceOperationError(
                    f"persistent parameter write failed: {type(exc).__name__}: {_sanitize(exc)}"
                ) from None
            logger.info(
                "persistent parameter write completed",
                extra={
                    "audit_action": "persistent_gain_write",
                    "motor_ids": [int(c["motor_id"]) for c in changes],
                    "parameter_ids": result.get("parameter_ids"),
                },
            )
            return {
                "ok": True,
                "operation": "persistent_gain_write",
                "channel": self._channel,
                "motor_ids": list(result.get("motor_ids", [])),
                "parameter_ids": result.get("parameter_ids", {}),
                "completed_at": utc_now_iso(),
            }
        finally:
            self.release_bus()
            self._release_if_pending()

    def run_set_zero(self) -> Dict[str, Any]:
        """Run the user-confirmed rs_tools.py mechanical-zero flow."""
        self.try_acquire_bus("write")
        try:
            method = getattr(self._scanner, "set_mechanical_zero", None)
            if not callable(method):
                raise ServiceOperationError("mechanical-zero owner is not available")
            try:
                result = method()
            except Exception as exc:
                raise ServiceOperationError(
                    f"mechanical-zero operation failed: {type(exc).__name__}: {_sanitize(exc)}"
                ) from None
            logger.warning(
                "mechanical zero set by manual user",
                extra={
                    "audit_action": "set_mechanical_zero",
                    "motor_ids": result.get("motor_ids", []),
                    "parameter_id": result.get("parameter_id"),
                },
            )
            return {
                "ok": True,
                "operation": "set_mechanical_zero",
                "channel": self._channel,
                "motor_ids": list(result.get("motor_ids", [])),
                "parameter_id": result.get("parameter_id"),
                "previous_positions": result.get("previous_positions", {}),
                "completed_at": utc_now_iso(),
            }
        finally:
            self.release_bus()
            self._release_if_pending()

    def begin_aging_motion(self) -> None:
        """Enable all motors and enter MIT mode through the shared owner.

        A confirmed aging start explicitly exits zero-torque mode first when it
        is still active (both own the same bus/Controller and cannot coexist).
        Fail closed: if the exit cannot complete, aging is refused.
        """
        with self._aging_state_lock:
            if self._aging_motion_active:
                raise AgingBusyError("aging motion is already active")
            snapshot = self.snapshot()
            if (
                snapshot.get("status") != STATUS_CONNECTED
                or set(snapshot.get("found_ids", ())) != set(self._expected_ids)
            ):
                raise ServiceOperationError(
                    "aging motion requires a complete scan of motor IDs 1..7"
                )
            if self.zero_torque_status()["status"] != "inactive":
                try:
                    self.run_zero_torque_stop()
                except ServiceOperationError as exc:
                    raise ZeroTorqueBusyError(
                        "zero-torque mode could not be exited before aging: "
                        f"{_sanitize(exc)}"
                    ) from None
                if self.zero_torque_status()["status"] != "inactive":
                    raise ZeroTorqueBusyError(
                        "zero-torque mode did not exit before aging"
                    )
            self._aging_motion_active = True

        acquired = False
        try:
            # Contends with the 10 Hz telemetry read on the shared Controller;
            # retry through those transient collisions (5 s budget).
            self._acquire_bus_with_retry("aging_setup", timeout=5.0)
            acquired = True
            disable = getattr(self._scanner, "disable_all", None)
            ensure = getattr(self._scanner, "ensure_mit_mode", None)
            enable = getattr(self._scanner, "enable_all", None)
            if not all(callable(fn) for fn in (disable, ensure, enable)):
                raise ServiceOperationError("aging MIT owner is not available")
            # Order matches the verified reference control stack
            # (F:/rebot-rs-record/MIT mit_all_in_one.py): disable -> switch to
            # MIT (with run_mode verification) -> enable. Switching mode while
            # enabled can leave motors in their previous mode, so the MIT servo
            # never engages (joints stay soft).
            disable()
            ensure()
            enable()
        except Exception:
            with self._aging_state_lock:
                self._aging_motion_active = False
            raise
        finally:
            if acquired:
                self.release_bus()
                self._release_if_pending()

    def send_aging_positions(
        self, positions: Sequence[float], velocity_limits: Sequence[float]
    ) -> None:
        """Send one aging MIT sample without creating another Controller.

        ``velocity_limits`` is retained for call-site compatibility; MIT mode
        has no velocity-limit parameter (the trajectory is already retimed at a
        bounded fixed speed before it reaches the aging runtime).
        """
        with self._aging_state_lock:
            if not self._aging_motion_active:
                raise ServiceOperationError("aging motion is not active")
        # Allow up to ~1 s to ride through a transient telemetry-read hold on
        # the shared Controller/Controller lock; a 50 Hz aging sample must not
        # fail the whole cycle because it collided with the 10 Hz telemetry poll.
        self._acquire_bus_with_retry("aging", timeout=1.0)
        try:
            send = getattr(self._scanner, "send_aging_mit", None)
            if not callable(send):
                raise ServiceOperationError("aging MIT sender is not available")
            send(positions)
        except ServiceOperationError:
            raise
        except Exception as exc:
            raise ServiceOperationError(
                f"aging MIT command failed: {type(exc).__name__}: {_sanitize(exc)}"
            ) from None
        finally:
            self.release_bus()
            self._release_if_pending()

    def finish_aging_motion(self, *, disable: bool) -> None:
        """End exclusive aging ownership and optionally disable all motors."""
        with self._aging_state_lock:
            active = self._aging_motion_active
        if not active:
            return
        acquired = False
        try:
            self.try_acquire_bus("aging_cleanup")
            acquired = True
            if disable:
                call = getattr(self._scanner, "disable_all", None)
                if not callable(call):
                    raise ServiceOperationError("aging cleanup lacks disable_all")
                call()
        except ServiceOperationError:
            raise
        except Exception as exc:
            raise ServiceOperationError(
                f"aging cleanup failed: {type(exc).__name__}: {_sanitize(exc)}"
            ) from None
        finally:
            if acquired:
                self.release_bus()
                self._release_if_pending()
            with self._aging_state_lock:
                self._aging_motion_active = False

    def aging_motion_active(self) -> bool:
        with self._aging_state_lock:
            return self._aging_motion_active

    def zero_torque_status(self) -> Dict[str, Any]:
        with self._zero_state_lock:
            return dict(self._zero_status)

    def run_zero_torque_start(self) -> Dict[str, Any]:
        """Start the backend-owned reference-script zero-torque loop."""
        with self._zero_lifecycle_lock:
            with self._zero_state_lock:
                status = self._zero_status["status"]
                if status in {"starting", "active"}:
                    return dict(self._zero_status)
                if status == "stopping":
                    raise ZeroTorqueBusyError("zero-torque mode is stopping")
                snapshot = self._state
                if (
                    snapshot.status != STATUS_CONNECTED
                    or set(snapshot.found_ids) != set(self._expected_ids)
                ):
                    raise ServiceOperationError(
                        "zero-torque mode requires a complete scan of motor IDs 1..7"
                    )
                self._zero_status.update(
                    status="starting", updated_at=utc_now_iso(), error=None
                )
                self._zero_cleanup_done = False
                self._zero_stop = threading.Event()

            acquired = False
            try:
                self.try_acquire_bus("zero")
                acquired = True
            except (ScanInProgressError, BusBusyError):
                with self._zero_state_lock:
                    self._zero_status.update(
                        status="error",
                        updated_at=utc_now_iso(),
                        error="CAN bus is busy; zero-torque start was not attempted",
                    )
                raise ZeroTorqueBusyError("CAN bus is busy") from None
            try:
                enable = getattr(self._scanner, "enable_all", None)
                ensure = getattr(self._scanner, "ensure_mit_mode", None)
                if not callable(enable) or not callable(ensure):
                    raise ServiceOperationError("zero-torque SDK owner is not available")
                enable()
                ensure()
                with self._zero_state_lock:
                    self._zero_status.update(
                        status="active",
                        started_at=utc_now_iso(),
                        updated_at=utc_now_iso(),
                        error=None,
                    )
                self._zero_thread = threading.Thread(
                    target=self._zero_loop,
                    name="rebot-zero-torque",
                    daemon=True,
                )
                self._zero_thread.start()
                logger.warning(
                    "zero-torque mode started by manual user",
                    extra={
                        "audit_action": "zero_torque_start",
                        "frequency_hz": self._zero_torque_hz,
                        "motor_ids": list(self._expected_ids),
                    },
                )
                return self.zero_torque_status()
            except Exception as exc:
                try:
                    disable = getattr(self._scanner, "disable_all", None)
                    if callable(disable):
                        disable()
                except Exception as cleanup_exc:
                    logger.error(
                        "zero-torque start cleanup disable failed",
                        extra={"audit_action": "zero_torque_cleanup", "error": _sanitize(cleanup_exc)},
                    )
                self._zero_cleanup_done = True
                with self._zero_state_lock:
                    self._zero_status.update(
                        status="error",
                        updated_at=utc_now_iso(),
                        error=f"zero-torque start failed: {type(exc).__name__}: {_sanitize(exc)}",
                    )
                raise ServiceOperationError(self._zero_status["error"]) from None
            finally:
                if acquired:
                    self.release_bus()
                    self._release_if_pending()

    def run_zero_torque_stop(self) -> Dict[str, Any]:
        """Stop/join the loop, then disable all motors in that exact order."""
        with self._zero_lifecycle_lock:
            with self._zero_state_lock:
                status = self._zero_status["status"]
                if status == "inactive":
                    return dict(self._zero_status)
                self._zero_status.update(status="stopping", updated_at=utc_now_iso())
                self._zero_stop.set()
                thread = self._zero_thread
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=max(2.0, 2.0 / self._zero_torque_hz))
            if thread is not None and thread.is_alive():
                with self._zero_state_lock:
                    self._zero_status.update(
                        status="error",
                        updated_at=utc_now_iso(),
                        error="zero-torque loop did not stop; disable was not attempted",
                    )
                raise ServiceOperationError(self._zero_status["error"])
            return self._disable_zero_torque(final_status="inactive")

    def shutdown_zero_torque(self) -> None:
        """Best-effort service-stop cleanup; never starts a loop."""
        try:
            if self.zero_torque_status()["status"] != "inactive":
                self.run_zero_torque_stop()
        except Exception as exc:
            logger.error(
                "zero-torque shutdown cleanup failed",
                extra={"audit_action": "zero_torque_shutdown_cleanup", "error": _sanitize(exc)},
            )

    def _zero_loop(self) -> None:
        period = 1.0 / self._zero_torque_hz
        try:
            while not self._zero_stop.is_set():
                tick = time.monotonic()
                try:
                    self.try_acquire_bus("zero")
                except (ScanInProgressError, BusBusyError):
                    self._zero_stop.wait(period)
                    continue
                try:
                    send = getattr(self._scanner, "send_zero_torque", None)
                    if not callable(send):
                        raise ServiceOperationError("zero-torque sender is not available")
                    send()
                finally:
                    self.release_bus()
                    self._release_if_pending()
                self._zero_stop.wait(max(0.0, period - (time.monotonic() - tick)))
        except Exception as exc:
            with self._zero_state_lock:
                self._zero_status.update(
                    status="error",
                    updated_at=utc_now_iso(),
                    error=f"zero-torque loop failed: {type(exc).__name__}: {_sanitize(exc)}",
                )
            self._zero_stop.set()
            try:
                self._disable_zero_torque(final_status="error")
            except Exception as cleanup_exc:
                logger.error(
                    "zero-torque loop cleanup failed",
                    extra={"audit_action": "zero_torque_cleanup", "error": _sanitize(cleanup_exc)},
                )

    def _disable_zero_torque(self, final_status: str) -> Dict[str, Any]:
        with self._zero_cleanup_lock:
            with self._zero_state_lock:
                if self._zero_cleanup_done:
                    return dict(self._zero_status)
            acquired = False
            deadline = time.monotonic() + 2.0
            while not acquired:
                try:
                    self.try_acquire_bus("zero_cleanup")
                    acquired = True
                except (ScanInProgressError, BusBusyError):
                    if time.monotonic() >= deadline:
                        with self._zero_state_lock:
                            self._zero_status.update(
                                status="error",
                                updated_at=utc_now_iso(),
                                error="zero-torque cleanup could not acquire the CAN bus; disable_all was not confirmed",
                            )
                        raise ServiceOperationError(self._zero_status["error"])
                    self._zero_stop.wait(0.02)
            with self._zero_state_lock:
                self._zero_cleanup_done = True
        cleanup_error = None
        try:
            disable = getattr(self._scanner, "disable_all", None)
            if not callable(disable):
                raise ServiceOperationError("zero-torque cleanup lacks disable_all")
            disable()
        except Exception as exc:
            cleanup_error = f"disable_all cleanup failed: {type(exc).__name__}: {_sanitize(exc)}"
        finally:
            self.release_bus()
            self._release_if_pending()
        with self._zero_state_lock:
            self._zero_status.update(
                status="error" if cleanup_error else final_status,
                updated_at=utc_now_iso(),
                error=cleanup_error or self._zero_status.get("error"),
            )
            self._zero_thread = None
        logger.warning(
            "zero-torque mode stopped",
            extra={
                "audit_action": "zero_torque_stop",
                "cleanup": "disable_all",
                "error": cleanup_error,
            },
        )
        if cleanup_error:
            raise ServiceOperationError(cleanup_error)
        return self.zero_torque_status()

    def read_telemetry(self, sequence: int) -> Dict[str, Any]:
        """Poll and parse feedback through the already connected owner.

        This method has no control/write fallback. The only SDK interaction is
        the receive-side ``poll_feedback_once`` and ``get_state`` parsing.
        """
        self.acquire_bus_for_telemetry()
        try:
            poll = getattr(self._scanner, "poll_feedback", None)
            motors_fn = getattr(self._scanner, "telemetry_motors", None)
            if not callable(poll) or not callable(motors_fn):
                raise ServiceOperationError("telemetry owner is not available")
            poll()
            from .telemetry import SOURCE_MOTORBRIDGE, UNITS, joint_from_motor_state

            motors = motors_fn()
            joints = []
            for motor_id in self._expected_ids:
                motor = motors.get(motor_id)
                state = motor.get_state() if motor is not None else None
                joints.append(joint_from_motor_state(motor_id, state))
            return {
                "timestamp": utc_now_iso(),
                "sequence": sequence,
                "channel": self._channel,
                "source": SOURCE_MOTORBRIDGE,
                "units": dict(UNITS),
                "joints": joints,
            }
        finally:
            self.release_bus()
            self._release_if_pending()

    def acquire_bus_for_telemetry(self) -> None:
        """Acquire the shared Controller with a short bounded wait.

        Zero-torque keepalive calls hold the lock only for one SDK write. A
        bounded wait lets receive-side telemetry run immediately afterwards
        without treating normal 50 Hz contention as a scan. The timeout stays
        finite so a hung scan/write cannot block a telemetry worker forever.
        """
        if self._scan_lock.acquire(timeout=_TELEMETRY_BUS_WAIT_S):
            self._bus_owner = "telemetry"
            return
        owner = self._bus_owner
        if owner == "scan":
            raise ScanInProgressError("A CAN scan is already in progress")
        raise BusBusyError(
            f"The CAN bus is held by {owner or 'another operation'}"
        )

    def try_acquire_bus(self, owner: str) -> None:
        """Non-blocking CAN-bus acquisition shared by scans and writes.

        Raises :class:`ScanInProgressError` when a scan holds the bus and
        :class:`BusBusyError` when a gated write operation holds it, so the
        API layer can answer with the matching 409 code. The bus is held
        for the whole operation (scan or write); ``release_bus`` must be
        called exactly once afterwards.
        """
        with self._zero_state_lock:
            zero_status = self._zero_status["status"]
        if owner not in {"zero", "zero_cleanup", "telemetry"} and zero_status in {
            "starting", "active", "stopping"
        }:
            raise ZeroTorqueBusyError("zero-torque mode owns the CAN bus")
        with self._aging_state_lock:
            aging_active = self._aging_motion_active
        if aging_active and owner not in {
            "aging", "aging_setup", "aging_cleanup", "telemetry"
        }:
            raise AgingBusyError("aging motion owns the CAN bus")
        if not self._scan_lock.acquire(blocking=False):
            if self._bus_owner == "write":
                raise BusBusyError(
                    "A gated write operation is holding the CAN bus"
                )
            raise ScanInProgressError(
                "A CAN scan is already in progress "
                f"(bus held by {self._bus_owner or 'unknown'})"
            )
        self._bus_owner = owner

    def _acquire_bus_with_retry(self, owner: str, *, timeout: float) -> None:
        """Acquire the bus, retrying through brief contention from telemetry.

        ``try_acquire_bus`` fails immediately on contention
        (:class:`ScanInProgressError` / :class:`BusBusyError`) because it is
        shared by scans and writes. Aging setup and every aging sample contend
        with the 10 Hz telemetry read on the same shared Controller, so a
        transient collision (the telemetry read holds the lock for well under a
        millisecond) must not fail aging. Real exclusive owners (zero-torque,
        another aging) still fail immediately via their distinct errors.
        """
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.try_acquire_bus(owner)
                return
            except (ScanInProgressError, BusBusyError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)

    def release_bus(self) -> None:
        """Release the bus after ``try_acquire_bus`` (idempotently safe only
        when paired correctly with a successful acquire)."""
        self._bus_owner = ""
        self._scan_lock.release()

    def disconnect(self) -> Dict[str, Any]:
        """Clear service state and release adapter resources (best-effort).

        Never sends disable or motion commands to the motors — the
        connection state purely represents the last completed scan.

        Bumps the scan generation so any scan still in flight is invalidated:
        when it finishes, its result is discarded instead of overwriting the
        cleared (``disconnected``) state.
        """
        if self.zero_torque_status()["status"] in {"starting", "active", "stopping"}:
            raise ZeroTorqueBusyError(
                "exit zero-torque mode before disconnecting"
            )
        if self.aging_motion_active():
            raise AgingBusyError("stop aging before disconnecting")
        state = ScanState(
            status=STATUS_DISCONNECTED,
            channel=self._channel,
            expected_ids=self._expected_ids,
            found_ids=(),
            missing_ids=(),
            started_at=None,
            completed_at=None,
            source=None,
            message="Disconnected by client request; service state cleared",
        )
        # Invalidate in-flight scans atomically with clearing the state, so
        # a stale scan can never write its result afterwards.
        with self._state_lock:
            self._generation += 1
            self._state = state
        logger.info(
            "disconnect: service state cleared",
            extra={"channel": self._channel, "generation": self._generation},
        )
        # Never close a native controller while scan/write/receive is using it.
        # The operation owner releases it in its finally block.
        if self._scan_lock.acquire(blocking=False):
            try:
                self._release_scanner()
            finally:
                self._scan_lock.release()
        else:
            self._release_pending = True
        return self.snapshot()

    def _release_scanner(self) -> None:
        try:
            self._scanner.release()
        except Exception as exc:
            logger.warning(
                "scanner release failed (ignored): %s: %s",
                type(exc).__name__,
                _sanitize(exc),
            )

    def _release_if_pending(self) -> None:
        if not self._release_pending:
            return
        if self._scan_lock.acquire(blocking=False):
            try:
                self._release_pending = False
                self._release_scanner()
            finally:
                self._scan_lock.release()

    # ---- internals ----

    def _run_scan_locked(self) -> Dict[str, Any]:
        started_at = utc_now_iso()
        with self._state_lock:
            generation = self._generation
            self._state = ScanState(
                status=STATUS_SCANNING,
                channel=self._channel,
                expected_ids=self._expected_ids,
                found_ids=(),
                missing_ids=self._expected_ids,
                started_at=started_at,
                completed_at=None,
                source=self._scanner.source,
                message="Scan in progress",
            )
        logger.info(
            "scan started",
            extra={
                "channel": self._channel,
                "adapter": self._scanner.source,
                "expected_ids": list(self._expected_ids),
                "generation": generation,
            },
        )
        try:
            outcome = self._scanner.scan(self._channel, self._expected_ids)
        except Exception as exc:
            # Defense in depth: adapters should return outcomes, not raise.
            logger.exception("scanner raised unexpectedly")
            outcome = ScanOutcome(
                fatal_message=f"scan raised {type(exc).__name__}: {_sanitize(exc)}"
            )
        completed_at = utc_now_iso()
        final = self._final_state(outcome, started_at, completed_at)
        # Write the result only when no disconnect bumped the generation
        # while this scan was running. Otherwise the scan is stale: keep the
        # cleared (disconnected) state and hand it back to the caller.
        with self._state_lock:
            if generation != self._generation:
                logger.info(
                    "discarding stale scan result: generation changed during scan",
                    extra={
                        "channel": self._channel,
                        "scan_generation": generation,
                        "current_generation": self._generation,
                        "stale_status": final.status,
                    },
                )
                return self._state.to_dict()
            self._state = final
        logger.info(
            "scan finished",
            extra={
                "channel": self._channel,
                "status": final.status,
                "found_ids": list(final.found_ids),
                "missing_ids": list(final.missing_ids),
                "generation": generation,
            },
        )
        return final.to_dict()

    def _final_state(
        self, outcome: ScanOutcome, started_at: str, completed_at: str
    ) -> ScanState:
        source = self._scanner.source
        if outcome.fatal_message:
            return ScanState(
                status=STATUS_ERROR,
                channel=self._channel,
                expected_ids=self._expected_ids,
                found_ids=(),
                missing_ids=self._expected_ids,
                started_at=started_at,
                completed_at=completed_at,
                source=source,
                message=f"Scan error: {outcome.fatal_message}",
            )
        expected = set(self._expected_ids)
        found = tuple(sorted(mid for mid in outcome.found_ids if mid in expected))
        found_set = set(found)
        missing = tuple(mid for mid in self._expected_ids if mid not in found_set)
        if missing:
            # Missing ANY expected ID => partial. Never presented as success.
            status = STATUS_PARTIAL
            parts = [f"missing motor IDs: {_format_ids(missing)}"]
            for mid in sorted(outcome.errors):
                parts.append(f"motor {mid}: {outcome.errors[mid]}")
            message = (
                f"Found {len(found)}/{len(self._expected_ids)} motors on "
                f"{self._channel}; " + "; ".join(parts)
            )
        else:
            status = STATUS_CONNECTED
            message = (
                f"All {len(self._expected_ids)} expected motors responded on "
                f"{self._channel}"
            )
        return ScanState(
            status=status,
            channel=self._channel,
            expected_ids=self._expected_ids,
            found_ids=found,
            missing_ids=missing,
            started_at=started_at,
            completed_at=completed_at,
            source=source,
            message=message,
        )
