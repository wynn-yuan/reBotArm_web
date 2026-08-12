"""Real motorbridge shared CAN adapter with separately gated writes.

Only enabled when ``REBOT_ADAPTER=motorbridge``. The SDK is imported lazily
at scan time; any import/construction failure yields a *fatal* outcome (API
status ``error``). There is no silent fallback to simulation and no claimed
success.

Confirmed SDK interface (motorbridge **0.5.1** — the ONLY supported version
— verified against the 0.4.9 sdist source ``src/motorbridge/core.py`` and
the vendor's own read-only scan in ``src/motorbridge/cli/scan.py``, then
re-verified for 0.5.1 by a byte-for-byte sdist diff (Phase 7B: the Python
binding layer is unchanged between 0.4.9 and 0.5.1); cross-checked with
``reBotArm_control/example/0x01rs06_test.py`` and
``reBotArm_control/config/rebotarm_rs.yaml``). The scan-relevant surface is
byte-for-byte identical to 0.3.8; 0.4.9 additionally ships ``__version__`` /
``get_version()``, package-level ``abi_version()`` / ``abi_capabilities()``,
``Motor.get_state()`` / ``request_feedback()`` and
``Controller.poll_feedback_once()`` (audited separately for telemetry, see
``rebot_server/telemetry.py`` — none of them is used by this scanner):

    module.__version__ == "0.5.1"                              # version gate
    controller = motorbridge.Controller(channel)               # channel only
    motor = controller.add_robstride_motor(motor_id, 0xFD, model)
    device_id, responder_id = motor.robstride_ping_host_id(0xFD, timeout_ms)
    motor.close()          # motor_handle_free — pure handle release
    controller.close_bus() # only if any motor was bound (vendor scan pattern)
    controller.close()     # motor_controller_free — pure resource release

Safety rules enforced here:

* Version gate: ``module.__version__`` must equal
  ``sdkcheck.REQUIRED_MOTORBRIDGE_VERSION`` (0.5.1). Any other version —
  or a build without ``__version__`` — aborts the scan with a fatal
  outcome. An unverified version could change call semantics in ways that
  invalidate the read-only audit.
* Allowed controller calls: ``add_robstride_motor``, ``close_bus``, ``close``.
  Allowed motor calls: ``robstride_ping_host_id`` (the ONLY ping API: timed,
  verified in motorbridge 0.5.1) and ``close``. The legacy untimed
  ``robstride_ping()`` is never used — an SDK build without the timed
  variant fails closed instead of falling back. Nothing else is allowed,
  see ``FORBIDDEN_SDK_CALLS``.
* ``Controller.shutdown()`` is deliberately NOT used: its native semantics
  are unproven from source and the vendor's read-only scan never calls it
  (note: ``Controller.__exit__`` calls it, so ``with Controller(...)`` must
  not be used here).
* ``RebotArm.disconnect`` is forbidden: ``rebotarm.py`` shows it calls
  ``disable_all()`` before closing, i.e. it writes control frames.
* A motor only counts as *found* when the ping returned a well-formed
  ``(device_id, responder_id)`` pair AND ``device_id`` equals the probed ID
  AND ``responder_id`` is a legal one-byte value. Exceptions, timeouts and
  malformed replies are recorded per-ID and never counted.
* The scan runs strictly serially, one motor ID after another.
"""

from __future__ import annotations

import importlib
import logging
import time
from typing import Any, Dict, Optional, Sequence, Tuple

from ..config import (
    DEFAULT_HOST_ID,
    DEFAULT_MIT_KD,
    DEFAULT_MIT_KP,
    MAX_PING_TIMEOUT_MS,
    MIN_PING_TIMEOUT_MS,
    ConfigError,
    validate_channel,
)
from ..models import ScanOutcome
from ..sdkcheck import REQUIRED_MOTORBRIDGE_VERSION
from .base import CanScanner

logger = logging.getLogger(__name__)

#: Motor models per the RS hardware reference (rebotarm_rs.yaml): J1–J3 are
#: rs-06, J4–J6 and the gripper are rs-00.
MOTOR_MODELS: Dict[int, str] = {
    1: "rs-06",
    2: "rs-06",
    3: "rs-06",
    4: "rs-00",
    5: "rs-00",
    6: "rs-00",
    7: "rs-00",
}

#: The single explicitly authorized motor write (Phase 5 user authorization,
#: narrow scope). Callable ONLY from the active-report telemetry session in
#: ``rebot_server/activereport.py``: ``True`` exactly once per motor when a
#: session starts, ``False`` on rollback and cleanup. This scanner never
#: calls it. motorbridge 0.5.1 source evidence (identical to 0.4.9, see
#: ``sdkcheck.py``): ``core.py`` —
#: ``robstride_set_active_report(self, enabled: bool) -> None`` forwards a
#: single boolean (1/0) to the native layer; the signature has no
#: position/velocity/torque/zero/KP/KD/mode parameter, so it cannot command
#: motion or enable the motor. README: it toggles RobStride ``comm_type`` 24
#: active *status reporting*. Every other write remains in
#: ``FORBIDDEN_SDK_CALLS``.
ACTIVE_REPORT_AUTHORIZED_CALL = "robstride_set_active_report"

# The operator-controlled zero-torque path is deliberately separate from
# passive telemetry. These are the only additional motor calls it may use.
ZERO_TORQUE_AUTHORIZED_CALLS = frozenset(
    {"enable_all", "ensure_mode", "send_mit", "disable_all"}
)

# Backend-owned aging loop.  These calls are only reachable through the
# separately gated AgingRuntime after a complete scan.  The scanner remains
# the sole owner of the existing Controller and motor handles.
AGING_MOTION_AUTHORIZED_CALLS = frozenset(
    {"enable_all", "ensure_mode", "send_pos_vel", "disable_all"}
)

# RobStride persistent position/velocity-loop gain IDs, verified against the
# vendor examples and motorbridge 0.5.1 CLI read/write-param path. They are
# not MIT-frame kp/kd and must never be used to claim zero torque.
PERSISTENT_GAIN_PARAM_IDS = {"kp": 0x701E, "kd": 0x701F}


def sdk_supports_zero_torque(module: Any) -> bool:
    """Check the exact 0.5.1 surface without constructing a controller."""
    controller = getattr(module, "Controller", None)
    core = getattr(module, "core", None)
    if core is None:
        try:
            core = importlib.import_module(f"{module.__name__}.core")
        except Exception:
            return False
    motor = getattr(module, "Motor", None) or getattr(core, "Motor", None)
    mode = getattr(module, "Mode", None) or getattr(core, "Mode", None)
    return all(
        (
            callable(getattr(controller, "enable_all", None)),
            callable(getattr(controller, "disable_all", None)),
            callable(getattr(motor, "ensure_mode", None)),
            callable(getattr(motor, "send_mit", None)),
            getattr(mode, "MIT", None) is not None,
        )
    )


def sdk_supports_aging_motion(module: Any) -> bool:
    """Check the MIT surface used by the verified control examples."""
    controller = getattr(module, "Controller", None)
    core = getattr(module, "core", None)
    if core is None:
        try:
            core = importlib.import_module(f"{module.__name__}.core")
        except Exception:
            return False
    motor = getattr(module, "Motor", None) or getattr(core, "Motor", None)
    mode = getattr(module, "Mode", None) or getattr(core, "Mode", None)
    return all(
        (
            callable(getattr(controller, "enable_all", None)),
            callable(getattr(controller, "disable_all", None)),
            callable(getattr(motor, "ensure_mode", None)),
            callable(getattr(motor, "send_mit", None)),
            callable(getattr(motor, "robstride_get_param_i8", None)),
            getattr(mode, "MIT", None) is not None,
        )
    )


def sdk_supports_persistent_gains(module: Any) -> bool:
    """Check the verified RobStride f32 read/write + save surface."""
    core = getattr(module, "core", None)
    if core is None:
        try:
            core = importlib.import_module(f"{module.__name__}.core")
        except Exception:
            return False
    motor = getattr(module, "Motor", None) or getattr(core, "Motor", None)
    return all(
        callable(getattr(motor, name, None))
        for name in (
            "robstride_write_param_f32",
            "robstride_get_param_f32",
            "store_parameters",
        )
    )


def sdk_supports_set_zero(module: Any) -> bool:
    """Check the rs_tools.py mechanical-zero method surface."""
    core = getattr(module, "core", None)
    if core is None:
        try:
            core = importlib.import_module(f"{module.__name__}.core")
        except Exception:
            return False
    motor = getattr(module, "Motor", None) or getattr(core, "Motor", None)
    return all(
        callable(getattr(motor, name, None))
        for name in (
            "disable",
            "set_zero_position",
            "robstride_get_param_f32",
            "store_parameters",
        )
    )

#: SDK calls the passive scan/telemetry paths must never make. Explicitly
#: gated manual, zero-torque and aging paths authorize only their documented
#: subsets; scan tests assert none occur while probing.
FORBIDDEN_SDK_CALLS = frozenset(
    {
        # legacy untimed ping — read-only, but NOT part of the verified
        # motorbridge 0.5.1 surface this adapter supports. Never called and
        # never used as a fallback: only robstride_ping_host_id is allowed.
        "robstride_ping",
        # enable / disable — control frames
        "enable", "disable", "enable_all", "disable_all",
        # ambiguous / control-context lifecycle (RebotArm.disconnect uses it)
        "shutdown",
        # mode switching / motion
        "ensure_mode", "send_mit", "send_vel",
        "send_force_pos", "robstride_send_pos_vel_pp",
        "robstride_send_pos_vel_csp",
        # homing / fault handling / parameter writes
        "set_zero_position", "clear_error", "store_parameters",
        "write_register_f32", "write_register_u32",
        "robstride_write_param_i8", "robstride_write_param_u8",
        "robstride_write_param_u16", "robstride_write_param_u32",
        "robstride_write_param_f32", "robstride_set_device_id",
        # damiao parameter writes (added in motorbridge 0.4.9)
        "damiao_write_param_f32", "damiao_write_param_u32",
        # anything from the RebotArm control stack
        "disconnect",
        # NOTE: ``robstride_set_active_report`` is intentionally NOT listed
        # here — it is the ONLY authorized write, whitelisted via
        # ``ACTIVE_REPORT_AUTHORIZED_CALL`` and restricted to the
        # telemetry session lifecycle in ``activereport.py``.
    }
)

_MESSAGE_LIMIT = 300


def _sanitize(message: object) -> str:
    """Collapse whitespace and truncate — keeps API messages clean."""
    text = " ".join(str(message).split())
    return text[:_MESSAGE_LIMIT]


def _is_can_byte(value: Any) -> bool:
    """True when *value* is a real int (not bool) fitting one CAN byte."""
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= 255
    )


class _IncompatibleSdkError(Exception):
    """The SDK does not provide the only allowed timed ping API.

    Raised internally and mapped to a fatal scan outcome (API status
    ``error``). It never propagates to the service/API layer and never
    triggers a fallback to the untimed ``robstride_ping()``.
    """


def _validate_ping_reply(reply: Any, motor_id: int) -> Tuple[bool, str]:
    """Validate a ``robstride_ping*`` reply strictly.

    Success requires ALL of:
      * the reply is a 2-element tuple/list ``(device_id, responder_id)``;
      * both elements are integers in the legal one-byte range 0..255
        (the SDK's ctypes ``c_uint8`` outputs guarantee this for the real
        SDK — the check guards against malformed/mock replies);
      * ``device_id`` equals the probed *motor_id* (README: "scan hits report
        the motor ID as probe/device_id");
      * ``responder_id`` is a legal byte. The responder is the host/feedback
        ID the motor answers with; the vendor's own scan treats any
        successful ping reply as a hit (its test suite accepts e.g.
        responder_id=0xFE for host_id=0xFD), so legality here means "valid
        byte value", not equality with the host ID.

    Returns ``(ok, reason)``; *reason* is a sanitized diagnostic for errors.
    """
    if not isinstance(reply, (tuple, list)) or len(reply) != 2:
        return False, (
            "malformed ping reply: expected (device_id, responder_id), got "
            f"{type(reply).__name__}"
        )
    device_id, responder_id = reply
    if not _is_can_byte(device_id) or not _is_can_byte(responder_id):
        return False, (
            "malformed ping reply: device_id/responder_id must be integers "
            f"in 0..255, got {reply!r}"
        )
    if device_id != motor_id:
        return False, (
            f"unexpected device_id in ping reply: got {device_id}, expected "
            f"{motor_id} (responder_id={responder_id})"
        )
    return True, ""


class MotorbridgeCanScanner(CanScanner):
    """Shared motorbridge 0.5.1 owner for scan, receive and gated writes."""

    source = "motorbridge"

    def __init__(
        self,
        host_id: int = DEFAULT_HOST_ID,
        ping_timeout_ms: int = 500,
        module_name: str = "motorbridge",
        persist: bool = False,
        allow_active_report: bool = False,
        mit_kp: Sequence[float] = DEFAULT_MIT_KP,
        mit_kd: Sequence[float] = DEFAULT_MIT_KD,
    ) -> None:
        self._host_id = host_id
        self._ping_timeout_ms = max(
            MIN_PING_TIMEOUT_MS, min(MAX_PING_TIMEOUT_MS, int(ping_timeout_ms))
        )
        self._module_name = module_name
        # Production uses one controller for scan, active-report receive and
        # manual enable/disable.  The default remains non-persistent for the
        # narrow unit-test scan seam.
        self._persist = bool(persist)
        self._allow_active_report = bool(allow_active_report)
        self._controller: Any = None
        self._motors: Dict[int, Any] = {}
        self._active_report_ids: list[int] = []
        # MIT position-servo gains per motor id (J1..J6 + gripper). Used by
        # aging motion; validated to seven positive finite values at config load.
        self._mit_kp = [float(value) for value in mit_kp]
        self._mit_kd = [float(value) for value in mit_kd]

    def scan(self, channel: str, expected_ids: Sequence[int]) -> ScanOutcome:
        try:
            validate_channel(channel)
        except ConfigError as exc:
            return ScanOutcome(fatal_message=f"invalid channel: {exc}")

        # A new scan replaces the previous connection owner while the service
        # bus lock is held; never create a second Controller on the same CAN.
        if self._controller is not None:
            self.release()

        # Lazy import: fail closed if the SDK is not installed/broken.
        try:
            module = importlib.import_module(self._module_name)
        except Exception as exc:
            return ScanOutcome(
                fatal_message=(
                    f"motorbridge SDK unavailable: {type(exc).__name__}: "
                    f"{_sanitize(exc)}"
                )
            )

        # Version gate (defense in depth; the startup gate in app.py runs
        # first): only the exact verified release may drive a scan.
        version = getattr(module, "__version__", None)
        if version != REQUIRED_MOTORBRIDGE_VERSION:
            return ScanOutcome(
                fatal_message=(
                    f"scan aborted: unsupported motorbridge version "
                    f"{version!r}; required {REQUIRED_MOTORBRIDGE_VERSION} "
                    "(fail closed)"
                )
            )

        controller: Any = None
        keep_controller = False
        try:
            # Real signature: Controller(channel) — channel only, no host_id.
            controller = module.Controller(channel)
        except Exception as exc:
            return ScanOutcome(
                fatal_message=(
                    f"scan aborted: {type(exc).__name__}: {_sanitize(exc)}"
                )
            )

        found: list[int] = []
        errors: Dict[int, str] = {}
        motors_by_id: Dict[int, Any] = {}
        bound = False  # any motor handle successfully created?
        try:
            try:
                for motor_id in sorted(set(expected_ids)):  # strictly serial
                    motor: Any = None
                    try:
                        model = MOTOR_MODELS.get(motor_id)
                        if model is None:
                            raise ValueError(
                                f"no motor model configured for id {motor_id}"
                            )
                        motor = controller.add_robstride_motor(
                            motor_id, self._host_id, model
                        )
                        if self._persist:
                            motors_by_id[motor_id] = motor
                        bound = True
                        reply = self._ping(motor)
                        ok, reason = _validate_ping_reply(reply, motor_id)
                        if ok:
                            found.append(motor_id)
                        else:
                            errors[motor_id] = reason
                    except _IncompatibleSdkError:
                        # Fail closed: an SDK without the timed ping API must
                        # never be probed via the untimed legacy variant.
                        raise
                    except Exception as exc:
                        # Per-ID isolation: one bad motor never aborts the scan.
                        errors[motor_id] = f"{type(exc).__name__}: {_sanitize(exc)}"
                    finally:
                        if not self._persist:
                            self._close_motor_best_effort(motor)
            except _IncompatibleSdkError as exc:
                return ScanOutcome(
                    found_ids=tuple(sorted(found)),
                    errors=errors,
                    fatal_message=f"scan aborted: {_sanitize(exc)}",
                )
            except Exception as exc:
                # Defense in depth: any unexpected loop-level failure is
                # fatal — never a claimed success.
                return ScanOutcome(
                    found_ids=tuple(sorted(found)),
                    errors=errors,
                    fatal_message=(
                        f"scan aborted: {type(exc).__name__}: {_sanitize(exc)}"
                    ),
                )
            if self._persist and not errors and set(found) == set(expected_ids):
                enabled: list[int] = []
                try:
                    if self._allow_active_report:
                        for motor_id in sorted(found):
                            motor = motors_by_id[motor_id]
                            motor.robstride_set_active_report(True)
                            enabled.append(motor_id)
                    self._controller = controller
                    self._motors = motors_by_id
                    self._active_report_ids = enabled
                    keep_controller = True
                except Exception as exc:
                    for motor_id in enabled:
                        try:
                            motors_by_id[motor_id].robstride_set_active_report(False)
                        except Exception:
                            pass
                    return ScanOutcome(
                        found_ids=tuple(sorted(found)),
                        errors=errors,
                        fatal_message=(
                            "active-report configuration failed: "
                            f"{type(exc).__name__}: {_sanitize(exc)}"
                        ),
                    )
            return ScanOutcome(found_ids=tuple(sorted(found)), errors=errors)
        finally:
            if not keep_controller:
                self._release_controller_best_effort(
                    controller, bound, motors_by_id if self._persist else None
                )

    def release(self) -> None:
        """Disable active reporting and release the one persistent owner."""
        controller, motors = self._controller, self._motors
        if controller is None:
            return
        for motor_id in list(self._active_report_ids):
            try:
                motors[motor_id].robstride_set_active_report(False)
            except Exception as exc:
                logger.warning("active report cleanup failed for %s: %s", motor_id, _sanitize(exc))
        self._active_report_ids = []
        self._controller = None
        self._motors = {}
        self._release_controller_best_effort(controller, bool(motors), motors)

    def enable_all(self) -> None:
        if self._controller is None:
            raise RuntimeError("controller is not connected")
        call = getattr(self._controller, "enable_all", None)
        if not callable(call):
            raise RuntimeError("motorbridge SDK lacks enable_all")
        call()

    def disable_all(self) -> None:
        if self._controller is None:
            raise RuntimeError("controller is not connected")
        call = getattr(self._controller, "disable_all", None)
        if not callable(call):
            raise RuntimeError("motorbridge SDK lacks disable_all")
        call()

    def poll_feedback(self) -> None:
        if self._controller is not None:
            call = getattr(self._controller, "poll_feedback_once", None)
            if not callable(call):
                raise RuntimeError("motorbridge SDK lacks poll_feedback_once")
            call()

    def telemetry_motors(self) -> Dict[int, Any]:
        return dict(self._motors)

    def ensure_mit_mode(self) -> None:
        """Switch every connected motor to the verified MIT mode.

        Mirrors the verified reference flow (F:\\rebot-rs-record\\MIT
        ``mit_all_in_one.py``): repeat the mode switch, then confirm
        ``run_mode`` (parameter 0x7005) reads 0 (= MIT) before reporting
        success. Without that confirmation the motor may stay in its previous
        mode and the MIT servo never engages (joints stay soft).
        """
        if self._controller is None or set(self._motors) != set(MOTOR_MODELS):
            raise RuntimeError("controller is not connected to all motors")
        module = importlib.import_module(self._module_name)
        mode = getattr(module, "Mode", None)
        mit = getattr(mode, "MIT", None) if mode is not None else None
        if mit is None:
            raise RuntimeError("motorbridge SDK lacks Mode.MIT")
        for motor_id in sorted(MOTOR_MODELS):
            motor = self._motors[motor_id]
            call = getattr(motor, "ensure_mode", None)
            if not callable(call):
                raise RuntimeError("motorbridge SDK lacks Motor.ensure_mode")
            for _ in range(3):
                call(mit, 1000)
                time.sleep(0.02)
            # Mandatory mode confirmation: read run_mode (0x7005); it must read
            # 0 (= MIT). Without this the motor may report success while still
            # in its previous mode and the MIT servo never engages.
            read_mode = getattr(motor, "robstride_get_param_i8", None)
            if not callable(read_mode):
                raise RuntimeError("motorbridge SDK lacks Motor.robstride_get_param_i8")
            run_mode = read_mode(0x7005, 500)
            if run_mode != 0:
                raise RuntimeError(
                    f"motor {motor_id} failed to switch into MIT "
                    f"(run_mode={run_mode})"
                )

    def send_zero_torque(self) -> None:
        """Send the exact reference-script all-zero MIT frame to all IDs."""
        if self._controller is None or set(self._motors) != set(MOTOR_MODELS):
            raise RuntimeError("controller is not connected to all motors")
        for motor_id in sorted(MOTOR_MODELS):
            motor = self._motors[motor_id]
            call = getattr(motor, "send_mit", None)
            if not callable(call):
                raise RuntimeError("motorbridge SDK lacks Motor.send_mit")
            call(0.0, 0.0, 0.0, 0.0, 0.0)

    def ensure_pos_vel_mode(self) -> None:
        """Switch all seven connected motors to RobStride POS_VEL mode."""
        if self._controller is None or set(self._motors) != set(MOTOR_MODELS):
            raise RuntimeError("controller is not connected to all motors")
        module = importlib.import_module(self._module_name)
        mode = getattr(module, "Mode", None)
        pos_vel = getattr(mode, "POS_VEL", None) if mode is not None else None
        if pos_vel is None:
            raise RuntimeError("motorbridge SDK lacks Mode.POS_VEL")
        for motor_id in sorted(MOTOR_MODELS):
            call = getattr(self._motors[motor_id], "ensure_mode", None)
            if not callable(call):
                raise RuntimeError("motorbridge SDK lacks Motor.ensure_mode")
            call(pos_vel, 1000)

    def send_aging_mit(self, positions: Sequence[float]) -> None:
        """Send one synchronized seven-joint MIT position-servo sample.

        Mirrors the reference control stack (reBotArm_control example
        ``3_mit_control.py``): MIT mode with the configured per-joint kp/kd,
        velocity feedforward 0 and torque feedforward 0. The arm is enabled and
        switched to MIT by ``ensure_mit_mode`` before the first sample.
        """
        if self._controller is None or set(self._motors) != set(MOTOR_MODELS):
            raise RuntimeError("controller is not connected to all motors")
        if len(positions) != len(MOTOR_MODELS):
            raise ValueError("aging command requires exactly seven positions")
        for index, motor_id in enumerate(sorted(MOTOR_MODELS)):
            motor = self._motors[motor_id]
            call = getattr(motor, "send_mit", None)
            if not callable(call):
                raise RuntimeError("motorbridge SDK lacks Motor.send_mit")
            call(
                float(positions[index]),
                0.0,
                float(self._mit_kp[index]),
                float(self._mit_kd[index]),
                0.0,
            )

    def write_persistent_gains(self, changes: Sequence[Dict[str, float]]) -> Dict[str, Any]:
        """Write verified RobStride persistent LocKp/SpdKp values.

        The legacy UI calls these fields KP/KD, but they are explicitly
        position-loop KP (0x701E) and speed-loop KP (0x701F). They are not
        MIT-frame gains and are never sent through send_mit.
        """
        if self._controller is None or set(self._motors) != set(MOTOR_MODELS):
            raise RuntimeError("controller is not connected to all motors")
        snapshots: list[tuple[Any, int, float]] = []
        written: list[tuple[Any, int, float]] = []
        for change in changes:
            motor_id = int(change["motor_id"])
            motor = self._motors[motor_id]
            read = getattr(motor, "robstride_get_param_f32", None)
            if not callable(read):
                raise RuntimeError("motorbridge SDK lacks verified RobStride parameter API")
            for field in ("kp", "kd"):
                param_id = PERSISTENT_GAIN_PARAM_IDS[field]
                snapshots.append((motor, param_id, float(read(param_id, 1000))))
        try:
            for change in changes:
                motor_id = int(change["motor_id"])
                motor = self._motors[motor_id]
                write = getattr(motor, "robstride_write_param_f32", None)
                read = getattr(motor, "robstride_get_param_f32", None)
                store = getattr(motor, "store_parameters", None)
                if not callable(write) or not callable(read) or not callable(store):
                    raise RuntimeError("motorbridge SDK lacks verified RobStride parameter API")
                values = {"kp": float(change["kp"]), "kd": float(change["kd"])}
                for field in ("kp", "kd"):
                    param_id = PERSISTENT_GAIN_PARAM_IDS[field]
                    write(param_id, values[field])
                    written.append((motor, param_id, next(v for m, p, v in snapshots if m is motor and p == param_id)))
                    verify = float(read(param_id, 1000))
                    if abs(verify - values[field]) > 1e-5 * max(1.0, abs(values[field])):
                        raise RuntimeError(f"motor {motor_id} parameter {field} verify mismatch")
            for change in changes:
                store = getattr(self._motors[int(change["motor_id"])], "store_parameters", None)
                if not callable(store):
                    raise RuntimeError("motorbridge SDK lacks store_parameters")
                store()
        except Exception:
            # Best-effort rollback of every value already touched. The API
            # still returns failure; no partial success is reported.
            for motor, param_id, old_value in reversed(written):
                try:
                    motor.robstride_write_param_f32(param_id, old_value)
                except Exception:
                    pass
            for motor, _, _ in written:
                try:
                    motor.store_parameters()
                except Exception:
                    pass
            raise
        applied = [int(change["motor_id"]) for change in changes]
        return {"motor_ids": applied, "parameter_ids": dict(PERSISTENT_GAIN_PARAM_IDS)}

    def set_mechanical_zero(self) -> Dict[str, Any]:
        """Apply the verified rs_tools.py per-motor mechanical-zero flow.

        The operation is intentionally not a generic parameter write:
        ``disable`` → read ``0x7019`` → ``set_zero_position`` →
        ``store_parameters`` for each connected motor, in fixed ID order.
        """
        if self._controller is None or set(self._motors) != set(MOTOR_MODELS):
            raise RuntimeError("controller is not connected to all motors")
        for motor_id in sorted(MOTOR_MODELS):
            motor = self._motors[motor_id]
            for name in ("disable", "set_zero_position", "robstride_get_param_f32", "store_parameters"):
                if not callable(getattr(motor, name, None)):
                    raise RuntimeError(f"motorbridge SDK lacks Motor.{name}")

        previous_positions: Dict[int, float | None] = {}
        for motor_id in sorted(MOTOR_MODELS):
            try:
                previous_positions[motor_id] = float(
                    self._motors[motor_id].robstride_get_param_f32(0x7019, 200)
                )
            except Exception:
                # rs_tools.py treats the pre-read as diagnostic. Preserve a
                # null audit value while keeping the verified write sequence.
                previous_positions[motor_id] = None

        completed: list[int] = []
        for motor_id in sorted(MOTOR_MODELS):
            motor = self._motors[motor_id]
            motor.disable()
            motor.set_zero_position()
            motor.store_parameters()
            completed.append(motor_id)
        return {
            "motor_ids": completed,
            "parameter_id": 0x7019,
            "previous_positions": previous_positions,
        }

    # ---- SDK interaction seams (verified against motorbridge 0.5.1) ----

    def _ping(self, motor: Any) -> Any:
        """Ping one motor via the ONLY permitted SDK call.

        ``robstride_ping_host_id(host_id, timeout_ms)`` is the single ping
        API this adapter may use (verified against motorbridge 0.5.1; it is
        also what the vendor's own CLI scan uses). There is deliberately NO
        fallback to the untimed ``robstride_ping()``: an SDK build without
        the timed method — or with a mismatched signature — raises
        :class:`_IncompatibleSdkError`, which the scan maps to a fatal
        outcome (status ``error``), fail closed.
        """
        ping = getattr(motor, "robstride_ping_host_id", None)
        if not callable(ping):
            raise _IncompatibleSdkError(
                "motorbridge SDK incompatible: motor object lacks "
                "robstride_ping_host_id(host_id, timeout_ms); only the "
                "verified motorbridge 0.5.1 interface is supported, no "
                "untimed ping fallback"
            )
        try:
            return ping(self._host_id, self._ping_timeout_ms)
        except TypeError as exc:
            # The arguments are fixed integers, so a TypeError here means the
            # SDK's signature does not match the verified 0.5.1 shape.
            raise _IncompatibleSdkError(
                "motorbridge SDK incompatible: robstride_ping_host_id("
                f"host_id, timeout_ms) signature mismatch: {_sanitize(exc)}"
            ) from None

    def _close_motor_best_effort(self, motor: Optional[Any]) -> None:
        if motor is None:
            return
        close = getattr(motor, "close", None)
        if callable(close):
            try:
                close()
            except Exception as exc:
                logger.warning(
                    "motor close failed (ignored): %s: %s",
                    type(exc).__name__,
                    _sanitize(exc),
                )

    def _release_controller_best_effort(
        self, controller: Any, bound: bool, motors: Optional[Dict[int, Any]] = None
    ) -> None:
        """Mirror the vendor's read-only scan cleanup (cli/scan.py):
        ``close_bus()`` only when a motor was bound, then ``close()``.
        Never ``shutdown()`` / ``disable_all()`` — those are control-path
        calls without read-only evidence."""
        if controller is None:
            return
        if motors:
            for motor_id in sorted(motors):
                self._close_motor_best_effort(motors[motor_id])
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
