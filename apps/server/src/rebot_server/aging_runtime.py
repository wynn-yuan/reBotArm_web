"""Backend-owned real aging cycle driven by the existing telemetry stream.

The runtime never constructs a Controller and never performs a second state
read.  It sends POS_VEL samples through ScanService's shared controller and
uses the exact 10 Hz frame already consumed by monitoring/trends for safety
checks and CSV recording.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from typing import Any, Mapping, Sequence

from .aging_recorder import AgingRecorder
from .config import ADAPTER_MOTORBRIDGE
from .models import utc_now_iso

logger = logging.getLogger(__name__)


CONTROL_HZ = 100.0
CONTROL_PERIOD_S = 1.0 / CONTROL_HZ
HOME_SPEED_RAD_S = 0.5
# Home-verification tolerance. MIT position servo under gravity/friction leaves
# a small steady-state residual (measured ~0.014 rad on M5); 0.01 rad was too
# tight and made aging fail at home even though every joint was at zero.
HOME_TOLERANCE_RAD = 0.05
HOME_TIMEOUT_S = 15.0
TELEMETRY_TIMEOUT_S = 0.8
# How long aging waits for real motorbridge telemetry to resume after the
# zero-torque->enable transition that momentarily interrupts active reporting.
TELEMETRY_READY_TIMEOUT_S = 15.0
FOLLOWING_ERROR_RAD = 0.5
# How many consecutive frames must exceed the following-error limit before the
# cycle is aborted.  A single transient frame (e.g. a telemetry read that just
# missed a quick position update) will not interrupt the run; a sustained loss
# of tracking (3 frames under the same error) will.
FOLLOWING_ERROR_CONSECUTIVE_LIMIT = 3
MAX_TRAJECTORY_SAMPLES = 250_000
JOINT_POSITION_LIMITS = (
    (-2.8, 2.8),
    (0.0, 3.14),
    (0.0, 3.14),
    (-1.57, 1.57),
    (-1.57, 1.57),
    (-3.14, 3.14),
    (0.0, 3.0),
)


class AgingRuntimeError(RuntimeError):
    code = "aging_runtime_error"
    status_code = 409


class AgingRuntimeUnavailable(AgingRuntimeError):
    code = "aging_motion_unavailable"
    status_code = 503


class AgingRuntimeBusy(AgingRuntimeError):
    code = "aging_motion_active"


class AgingValidationError(AgingRuntimeError):
    code = "invalid_aging_action"
    status_code = 400


class AgingCommunicationLost(AgingRuntimeError):
    code = "aging_communication_lost"


class AgingSafetyFault(AgingRuntimeError):
    code = "aging_safety_fault"


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


class AgingRuntime:
    """Thread-safe aging lifecycle with real motion and telemetry recording."""

    def __init__(
        self, settings, service, recorder: AgingRecorder, gravity_model=None
    ) -> None:
        self._settings = settings
        self._service = service
        self._recorder = recorder
        self._gravity = gravity_model  # GravityModel | None
        self._lock = threading.RLock()
        self._telemetry_lock = threading.RLock()
        self._latest_frame: dict[str, Any] | None = None
        self._latest_frame_at = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._temp_limit_c: float | None = None
        self._following_error_count = 0
        self._status: dict[str, Any] = {
            "available": bool(settings.allow_aging_write),
            "status": "inactive",
            "phase": "idle",
            "action_id": None,
            "action_name": None,
            "loop_mode": None,
            "round": 0,
            "completed_rounds": 0,
            "target_rounds": None,
            "started_at": None,
            "updated_at": utc_now_iso(),
            "stop_requested": False,
            "temp_limit_c": None,
            "temp_protection": None,
            "error": None,
            "elapsed_seconds": 0.0,
        }

    @property
    def available(self) -> bool:
        return bool(
            self._settings.adapter == ADAPTER_MOTORBRIDGE
            and self._settings.allow_aging_write
            and self._settings.allow_active_report_write
            and self._recorder.available
        )

    def accept_frame(self, frame: Mapping[str, Any]) -> None:
        """Observe one already-published real frame and forward it to disk."""
        snapshot = {
            "timestamp": frame.get("timestamp"),
            "sequence": frame.get("sequence"),
            "channel": frame.get("channel"),
            "source": frame.get("source"),
            "units": dict(frame.get("units", {})),
            "joints": [dict(joint) for joint in frame.get("joints", [])],
        }
        with self._telemetry_lock:
            self._latest_frame = snapshot
            self._latest_frame_at = time.monotonic()
        self._recorder.accept_frame(snapshot)

    def status(self) -> dict[str, Any]:
        with self._lock:
            result = dict(self._status)
        recording = self._recorder.status()
        result.update(
            available=self.available,
            recording_status=recording["status"],
            session_path=recording["session_path"],
            frames_written=recording["frames_written"],
            rows_written=recording["rows_written"],
            root=recording["root"],
            recording_error=recording["error"],
        )
        return result

    def start(self, action: Mapping[str, Any], config: Mapping[str, Any]) -> dict[str, Any]:
        if not self.available:
            raise AgingRuntimeUnavailable("aging motion or log storage is not enabled")
        normalized_action, normalized_config = self._validate(action, config)
        self._fresh_positions(check_status=True)
        with self._lock:
            if self._thread is not None or self._status["status"] in {
                "starting", "running", "stopping"
            }:
                raise AgingRuntimeBusy("an aging cycle is already active")
            self._stop = threading.Event()
            self._temp_limit_c = normalized_config.get("temp_limit_c")
            self._status.update(
                status="starting",
                phase="preflight",
                action_id=normalized_action["id"],
                action_name=normalized_action["name"],
                loop_mode=normalized_config["loop_mode"],
                round=0,
                completed_rounds=0,
                target_rounds=normalized_config.get("loop_count"),
                started_at=utc_now_iso(),
                updated_at=utc_now_iso(),
                stop_requested=False,
                temp_limit_c=self._temp_limit_c,
                temp_protection=None,
                error=None,
                elapsed_seconds=0.0,
            )

        try:
            self._recorder.start(
                {
                    "kind": "aging_cycle",
                    "action_id": normalized_action["id"],
                    "action_name": normalized_action["name"],
                    "config": normalized_config,
                },
                processed_action=dict(action),
            )
            self._service.begin_aging_motion()
            thread = threading.Thread(
                target=self._run,
                args=(normalized_action, normalized_config),
                name="rebot-aging-runtime",
                daemon=True,
            )
            with self._lock:
                self._thread = thread
                self._status.update(status="running", phase="initial_homing", updated_at=utc_now_iso())
            thread.start()
        except Exception as exc:
            try:
                self._service.finish_aging_motion(disable=True)
            except Exception:
                pass
            self._recorder.stop()
            with self._lock:
                self._thread = None
                self._status.update(
                    status="error",
                    phase="failed",
                    updated_at=utc_now_iso(),
                    error=f"{type(exc).__name__}: {exc}",
                )
            raise AgingRuntimeError(str(exc)) from None
        return self.status()

    def request_stop(self) -> dict[str, Any]:
        with self._lock:
            if self._status["status"] not in {"starting", "running", "stopping"}:
                return self.status()
            self._stop.set()
            self._status.update(
                status="stopping", stop_requested=True, updated_at=utc_now_iso()
            )
        return self.status()

    def shutdown(self) -> None:
        self.request_stop()
        with self._lock:
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=HOME_TIMEOUT_S + 5.0)

    def _run(self, action: dict[str, Any], config: dict[str, Any]) -> None:
        final_status = "completed"
        final_phase = "completed"
        error: str | None = None
        disable = True
        started = time.monotonic()
        velocity_limits = action["velocity_limits"]
        # Update elapsed_seconds once per cycle.
        _update_elapsed = lambda: self._set_phase(
            self._status["phase"], elapsed_seconds=time.monotonic() - started
        )
        try:
            self._set_phase("initial_homing")
            # Exit from zero-torque (enable->disable->enable) momentarily
            # interrupts active-report telemetry (Phase 7M). Do not start the
            # first home command until real motorbridge telemetry is flowing
            # again, otherwise the follow-error / home-verify checks hold the
            # arm for lack of fresh frames.
            self._wait_telemetry_ready()
            self._home()
            _update_elapsed()
            if not self._stop.is_set():
                self._move_smooth(action["samples"][0], velocity_limits, "positioning")

            while not self._stop.is_set():
                round_number = self.status()["completed_rounds"] + 1
                self._set_phase("running_trajectory", round=round_number)
                self._play(action["samples"], velocity_limits)
                _update_elapsed()
                # Temperature protection (or a manual stop mid-trajectory)
                # already requested a stop; go straight to the stopping home
                # sequence instead of returning home a second time.
                if self._stop.is_set():
                    break
                self._set_phase("returning_home")
                self._home()
                self._set_phase("verifying_home")
                self._verify_home()
                with self._lock:
                    self._status["completed_rounds"] = round_number
                    self._status["updated_at"] = utc_now_iso()
                    self._status["elapsed_seconds"] = time.monotonic() - started

                if self._stop.is_set() or self._is_complete(config, round_number, started):
                    break
                self._set_phase("interval_wait")
                if self._stop.wait(config["interval_sec"]):
                    break
                self._set_phase("verifying_home")
                self._verify_home()

            if self._stop.is_set():
                self._set_phase("stopping")
                self._home()
                self._verify_home()
        except AgingCommunicationLost as exc:
            final_status = "held"
            final_phase = "held"
            error = str(exc)
            disable = False
            logger.error("aging cycle held: %s", error)
            self._try_append_event({
                "type": "communication_lost",
                "error": str(exc),
                "phase": self._status.get("phase"),
                "round": self._status.get("round"),
                "elapsed_seconds": time.monotonic() - started,
            })
        except AgingSafetyFault as exc:
            final_status = "error"
            final_phase = "failed"
            error = str(exc)
            disable = True
            logger.error("aging safety fault: %s", error)
            self._try_append_event({
                "type": "safety_fault",
                "error": str(exc),
                "phase": self._status.get("phase"),
                "round": self._status.get("round"),
                "elapsed_seconds": time.monotonic() - started,
            })
            try:
                self._fresh_positions(check_status=False)
                self._set_phase("fault_homing")
                self._home()
                self._verify_home()
            except AgingCommunicationLost:
                final_status = "held"
                final_phase = "held"
                disable = False
                self._try_append_event({
                    "type": "communication_lost",
                    "error": "fault homing failed: communication lost",
                    "elapsed_seconds": time.monotonic() - started,
                })
            except Exception as cleanup_exc:
                error = f"{error}; cleanup: {type(cleanup_exc).__name__}: {cleanup_exc}"
                logger.error("aging cleanup failed: %s", cleanup_exc)
        except Exception as exc:
            final_status = "error"
            final_phase = "failed"
            error = f"{type(exc).__name__}: {exc}"
            logger.error("aging cycle failed: %s", error)
            self._try_append_event({
                "type": "runtime_error",
                "error": str(exc),
                "phase": self._status.get("phase"),
                "round": self._status.get("round"),
                "elapsed_seconds": time.monotonic() - started,
            })
            try:
                self._fresh_positions(check_status=False)
                self._set_phase("fault_homing")
                self._home()
                self._verify_home()
            except AgingCommunicationLost:
                final_status = "held"
                final_phase = "held"
                disable = False
                self._try_append_event({
                    "type": "communication_lost",
                    "error": "fault homing failed: communication lost",
                    "elapsed_seconds": time.monotonic() - started,
                })
            except Exception as cleanup_exc:
                error = f"{error}; cleanup: {type(cleanup_exc).__name__}: {cleanup_exc}"
                logger.error("aging cleanup failed: %s", cleanup_exc)
        finally:
            try:
                self._service.finish_aging_motion(disable=disable)
            except Exception as exc:
                final_status = "error"
                final_phase = "failed"
                error = error or f"cleanup failed: {type(exc).__name__}: {exc}"
            self._try_append_event({
                "type": "stopped",
                "status": final_status,
                "error": error,
                "elapsed_seconds": time.monotonic() - started,
            })
            self._recorder.stop()
            with self._lock:
                self._thread = None
                self._status.update(
                    status=final_status,
                    phase=final_phase,
                    updated_at=utc_now_iso(),
                    error=error,
                    elapsed_seconds=time.monotonic() - started,
                )

    def _check_temperature(self) -> tuple[int, float, float] | None:
        """Return ``(joint_id, temperature, limit)`` of the first joint whose MOS
        temperature reaches the configured limit, or ``None`` when no limit is
        set / no fresh frame is available. Temperature comes from the same real
        telemetry frame already consumed by monitoring (never a second read).
        """
        if self._temp_limit_c is None:
            return None
        with self._telemetry_lock:
            frame = self._latest_frame
        if frame is None:
            return None
        joints = frame.get("joints")
        if not isinstance(joints, list):
            return None
        for joint in joints:
            temperature = joint.get("temperature")
            temp = temperature.get("mos") if isinstance(temperature, Mapping) else None
            if (
                isinstance(temp, (int, float))
                and not isinstance(temp, bool)
                and math.isfinite(float(temp))
                and float(temp) >= self._temp_limit_c
            ):
                return (int(joint.get("id")), float(temp), float(self._temp_limit_c))
        return None

    def _trigger_temp_protection(self, joint_id: int, temperature: float, limit: float) -> None:
        """Stop the cycle and return home when a joint exceeds the temperature limit.

        The event is appended to the active session's ``events.jsonl`` so the
        operator can audit exactly when and why aging stopped.
        """
        with self._lock:
            self._status["temp_protection"] = {
                "joint": joint_id,
                "temperature_c": temperature,
                "limit_c": limit,
            }
        self._stop.set()
        self._set_phase("stopping")
        self._try_append_event({
            "type": "safety_temp_exceeded",
            "joint_id": joint_id,
            "temperature_c": temperature,
            "limit_c": limit,
        })

    def _play(self, samples: Sequence[Sequence[float]], velocity_limits: Sequence[float]) -> None:
        deadline = time.monotonic()
        for sample in samples:
            if self._stop.is_set():
                return
            violation = self._check_temperature()
            if violation is not None:
                self._trigger_temp_protection(*violation)
                return
            if self._recorder.status()["status"] != "recording":
                self._try_append_event({
                    "type": "recording_stopped",
                    "error": "telemetry recording stopped unexpectedly",
                })
                raise AgingSafetyFault("telemetry recording stopped unexpectedly")
            self._send(sample, velocity_limits)
            deadline += CONTROL_PERIOD_S
            deadline = self._pace(deadline)

    def _move_smooth(
        self, target: Sequence[float], velocity_limits: Sequence[float], phase: str
    ) -> None:
        start = self._fresh_positions(check_status=True)
        max_error = max(abs(float(target[i]) - start[i]) for i in range(7))
        if max_error <= HOME_TOLERANCE_RAD:
            return
        duration = min(HOME_TIMEOUT_S - 3.0, max(0.2, 2.0 * max_error / HOME_SPEED_RAD_S))
        steps = max(2, int(math.ceil(duration * CONTROL_HZ)))
        self._set_phase(phase)
        deadline = time.monotonic()
        capped_limits = [min(float(v), HOME_SPEED_RAD_S) for v in velocity_limits]
        for index in range(1, steps + 1):
            if self._stop.is_set() and phase == "positioning":
                return
            s = index / steps
            blend = 10.0 * s**3 - 15.0 * s**4 + 6.0 * s**5
            sample = [start[j] + (float(target[j]) - start[j]) * blend for j in range(7)]
            self._send(sample, capped_limits)
            deadline += CONTROL_PERIOD_S
            deadline = self._pace(deadline)

    def _home(self) -> None:
        self._move_smooth([0.0] * 7, [HOME_SPEED_RAD_S] * 7, self.status()["phase"])
        self._verify_home()

    def _verify_home(self) -> None:
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            positions = self._fresh_positions(check_status=True)
            if max(abs(value) for value in positions) <= HOME_TOLERANCE_RAD:
                return
            time.sleep(0.05)
        self._try_append_event({
            "type": "home_verification_failed",
            "joint_positions": [round(float(v), 4) for v in positions],
            "tolerance_rad": HOME_TOLERANCE_RAD,
        })
        raise AgingSafetyFault("home verification failed")

    def _send(self, target: Sequence[float], velocity_limits: Sequence[float]) -> None:
        positions = self._fresh_positions(check_status=True)
        error = max(abs(positions[i] - float(target[i])) for i in range(7))
        if error > FOLLOWING_ERROR_RAD:
            self._following_error_count += 1
            if self._following_error_count >= FOLLOWING_ERROR_CONSECUTIVE_LIMIT:
                self._try_append_event({
                    "type": "following_error",
                    "error": f"following error exceeded {FOLLOWING_ERROR_RAD} rad "
                             f"({self._following_error_count} consecutive frames, max {error:.3f})",
                    "max_error_rad": round(float(error), 4),
                    "consecutive_count": self._following_error_count,
                    "joint_positions": [round(float(p), 4) for p in positions],
                    "target_positions": [round(float(t), 4) for t in target],
                })
                raise AgingSafetyFault(
                    f"following error exceeded {FOLLOWING_ERROR_RAD} rad "
                    f"({self._following_error_count} consecutive frames, max {error:.3f})"
                )
            return  # skip this frame, the arm will catch up
        self._following_error_count = 0
        # Compute gravity torque if the model is enabled.
        gravity_torque: list[float] | None = None
        if self._gravity is not None:
            gravity_torque = self._gravity.compute(positions)
        self._service.send_aging_positions(target, velocity_limits, gravity_torque)

    def _fresh_positions(self, *, check_status: bool) -> list[float]:
        with self._telemetry_lock:
            frame = self._latest_frame
            age = time.monotonic() - self._latest_frame_at
        if frame is None or age > TELEMETRY_TIMEOUT_S:
            raise AgingCommunicationLost("real telemetry is unavailable or stale")
        if frame.get("source") != "motorbridge":
            raise AgingCommunicationLost("aging requires real motorbridge telemetry")
        joints = frame.get("joints")
        if not isinstance(joints, list) or len(joints) != 7:
            raise AgingCommunicationLost("real telemetry must contain seven joints")
        ordered = sorted(joints, key=lambda item: item.get("id", 0))
        positions: list[float] = []
        for expected_id, joint in enumerate(ordered, 1):
            if joint.get("id") != expected_id or joint.get("freshness") != "fresh":
                raise AgingCommunicationLost(f"joint {expected_id} telemetry is not fresh")
            position = joint.get("position")
            if not _finite(position):
                raise AgingCommunicationLost(f"joint {expected_id} position is unavailable")
            status_code = joint.get("status_code")
            if check_status and status_code not in (0, None):
                raise AgingSafetyFault(f"joint {expected_id} status code {status_code}")
            positions.append(float(position))
        return positions

    def _wait_telemetry_ready(self, timeout: float = TELEMETRY_READY_TIMEOUT_S) -> None:
        """Wait until a fresh real motorbridge telemetry frame is available.

        Callers hold no lock here. Polls ``_fresh_positions`` until it
        succeeds or the bounded timeout elapses (then fail closed). A manual
        stop during the wait aborts early.
        """
        deadline = time.monotonic() + timeout
        while True:
            try:
                self._fresh_positions(check_status=True)
                return
            except AgingCommunicationLost:
                if self._stop.is_set():
                    raise AgingCommunicationLost(
                        "aging stopped while waiting for telemetry"
                    ) from None
                if time.monotonic() >= deadline:
                    raise AgingCommunicationLost(
                        "real telemetry did not become available before aging"
                    ) from None
                time.sleep(0.05)
            except AgingSafetyFault:
                raise

    def _set_phase(self, phase: str, **changes: Any) -> None:
        with self._lock:
            self._status.update(phase=phase, updated_at=utc_now_iso(), **changes)

    def _try_append_event(self, event: dict[str, Any]) -> None:
        """Append an event to the active session's events.jsonl.

        Failures are silently caught: the event is a best-effort audit trail
        and must never block the aging control loop.
        """
        try:
            self._recorder.append_event(event)
        except Exception:
            pass

    @staticmethod
    def _pace(deadline: float) -> float:
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)
            return deadline
        # Never burst multiple delayed trajectory frames to "catch up". A
        # late cycle resumes from now, preserving order and bounded command
        # rate even if CAN or the scheduler stalls briefly.
        return time.monotonic()

    @staticmethod
    def _is_complete(config: Mapping[str, Any], rounds: int, started: float) -> bool:
        if config["loop_mode"] == "count":
            return rounds >= config["loop_count"]
        if config["loop_mode"] == "duration":
            return time.monotonic() - started >= config["duration_sec"]
        return False

    @staticmethod
    def _validate(
        action: Mapping[str, Any], config: Mapping[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        if action.get("version") != "processed":
            raise AgingValidationError("aging requires a processed action")
        trails = action.get("trails")
        if not isinstance(trails, list) or len(trails) != 7:
            raise AgingValidationError("processed action must contain seven joint trails")
        lengths = {len(trail) for trail in trails if isinstance(trail, list)}
        if len(lengths) != 1 or len(lengths) == 0:
            raise AgingValidationError("all seven trails must have the same length")
        sample_count = next(iter(lengths))
        if sample_count < 2 or sample_count > MAX_TRAJECTORY_SAMPLES:
            raise AgingValidationError("processed action sample count is out of range")
        if any(not _finite(value) for trail in trails for value in trail):
            raise AgingValidationError("processed action contains a non-finite position")
        for joint, trail in enumerate(trails):
            lower, upper = JOINT_POSITION_LIMITS[joint]
            if any(float(value) < lower or float(value) > upper for value in trail):
                raise AgingValidationError(f"joint {joint + 1} exceeds its position limit")
        sampling_hz = action.get("samplingHz")
        if not _finite(sampling_hz) or abs(float(sampling_hz) - CONTROL_HZ) > 1e-6:
            raise AgingValidationError("processed action must be sampled at 100 Hz")
        processing = action.get("processing")
        velocity_limits = processing.get("maxJointVelocity") if isinstance(processing, Mapping) else None
        if (
            not isinstance(velocity_limits, list)
            or len(velocity_limits) != 7
            or any(not _finite(v) or float(v) <= 0.0 or float(v) > 10.0 for v in velocity_limits)
        ):
            raise AgingValidationError("processed action requires seven valid velocity limits")
        for joint, trail in enumerate(trails):
            limit = float(velocity_limits[joint]) * 1.01
            for index in range(1, sample_count):
                velocity = abs(float(trail[index]) - float(trail[index - 1])) * CONTROL_HZ
                if velocity > limit + 1e-9:
                    raise AgingValidationError(f"joint {joint + 1} exceeds its velocity limit")
        samples = [[float(trails[j][i]) for j in range(7)] for i in range(sample_count)]

        loop_mode = config.get("loop_mode")
        if loop_mode not in {"count", "duration", "infinite"}:
            raise AgingValidationError("loop_mode must be count, duration, or infinite")
        interval = config.get("interval_sec", 0)
        if not _finite(interval) or not 0 <= float(interval) <= 3600:
            raise AgingValidationError("interval_sec must be between 0 and 3600")
        normalized_config: dict[str, Any] = {
            "loop_mode": loop_mode,
            "interval_sec": float(interval),
        }
        if loop_mode == "count":
            count = config.get("loop_count")
            if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 1_000_000:
                raise AgingValidationError("loop_count must be a positive integer")
            normalized_config["loop_count"] = count
        elif loop_mode == "duration":
            minutes = config.get("duration_minutes")
            if not _finite(minutes) or float(minutes) <= 0:
                raise AgingValidationError("duration_minutes must be positive")
            normalized_config["duration_sec"] = float(minutes) * 60.0

        # Optional temperature protection: when any joint's MOS temperature
        # reaches this limit during execution, aging stops and returns home.
        temp_limit = config.get("temp_limit_c")
        if temp_limit is not None:
            if not _finite(temp_limit) or not 0 < float(temp_limit) <= 200:
                raise AgingValidationError("temp_limit_c must be between 0 and 200")
            normalized_config["temp_limit_c"] = float(temp_limit)

        normalized_action = {
            "id": str(action.get("id") or "processed-action"),
            "name": str(action.get("name") or "processed action"),
            "samples": samples,
            "velocity_limits": [float(v) for v in velocity_limits],
        }
        return normalized_action, normalized_config
