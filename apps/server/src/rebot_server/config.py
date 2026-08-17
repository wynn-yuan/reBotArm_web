"""Service configuration.

All runtime configuration comes from environment variables (optionally via a
local ``.env`` file). There is deliberately *no* request-time configuration
surface: the CAN channel is strictly validated and the expected motor IDs are
fixed on the backend — API clients cannot influence either.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass
from typing import Mapping, Optional

ADAPTER_SIMULATION = "simulation"
ADAPTER_MOTORBRIDGE = "motorbridge"
_SUPPORTED_ADAPTERS = (ADAPTER_SIMULATION, ADAPTER_MOTORBRIDGE)

#: Only ``can<number>`` is accepted (e.g. ``can0``). Anything else —
#: including ``vcan0``, ``slcan0``, whitespace, or shell metacharacters —
#: is rejected.
CHANNEL_PATTERN = re.compile(r"^can[0-9]+$")

DEFAULT_CHANNEL = "can0"
#: Expected motor IDs are a backend constant. They are never taken from a
#: request and never configurable at runtime.
DEFAULT_EXPECTED_MOTOR_IDS = (1, 2, 3, 4, 5, 6, 7)
DEFAULT_HOST_ID = 0xFD  # robstride host / feedback ID
#: Per-ping timeout passed to the SDK (``robstride_ping_host_id``). 500 ms is
#: the SDK/vendor default; values are clamped to [MIN, MAX] so a scan of 7
#: motors can never block the API for more than ~14 s.
DEFAULT_PING_TIMEOUT_MS = 500
MIN_PING_TIMEOUT_MS = 10
MAX_PING_TIMEOUT_MS = 2000
#: Telemetry stream rate for ``/ws/robot/telemetry`` (simulation mode and the
#: motorbridge active-report session). Clamped to [MIN, MAX] so the stream is
#: always bounded.
DEFAULT_TELEMETRY_HZ = 10.0
MIN_TELEMETRY_HZ = 1.0
MAX_TELEMETRY_HZ = 50.0
#: Explicit authorization for the ONE permitted motor write (default OFF,
#: fail closed). Real RobStride telemetry in motorbridge mode requires
#: toggling the motor's active status reporting via
#: ``robstride_set_active_report`` — authorized narrowly: True once per
#: motor when a telemetry session starts, False on cleanup/rollback. With
#: this flag off no motor is ever written to. See ``activereport.py``.
DEFAULT_ALLOW_ACTIVE_REPORT_WRITE = False
#: Phase 7I manual-write gate. It unlocks only a user-requested
#: ``enable_all`` or ``disable_all`` call after a full connection scan.
#: Parameter, homing, zeroing, MIT and motion writes are intentionally absent.
DEFAULT_ALLOW_ENABLE_WRITE = False
#: Explicit opt-in for verified persistent position/velocity gain writes.
DEFAULT_ALLOW_PARAMETER_WRITE = False
#: Explicit opt-in for the operator-controlled zero-torque state machine.
DEFAULT_ALLOW_ZERO_TORQUE_WRITE = False
#: Explicit opt-in for the destructive mechanical-zero persistence operation.
DEFAULT_ALLOW_SET_ZERO_WRITE = False
#: Explicit opt-in for backend-owned POS_VEL aging motion.  This is separate
#: from manual enable/disable and zero-torque recording so deployments can
#: fail closed unless the complete aging loop is intentionally enabled.
DEFAULT_ALLOW_AGING_WRITE = False
DEFAULT_ZERO_TORQUE_HZ = 50.0
MIN_ZERO_TORQUE_HZ = 1.0
MAX_ZERO_TORQUE_HZ = 50.0
DEFAULT_HTTP_HOST = "127.0.0.1"
DEFAULT_HTTP_PORT = 8000
#: Optional directory with the pre-built web UI (Vite ``dist/``). Empty
#: (default) disables static hosting entirely. When set, the app factory
#: validates it (existing directory + index.html) and refuses to start
#: otherwise — fail closed. See ``staticweb.py``.
DEFAULT_WEB_DIST_DIR = ""
# Restricted aging-log persistence is disabled when this is empty.  The
# configured root is the only filesystem boundary exposed by the file APIs.
DEFAULT_AGING_LOG_ROOT = ""
DEFAULT_AGING_LOG_MIN_FREE_BYTES = 100 * 1024 * 1024
DEFAULT_AGING_LOG_SEGMENT_SECONDS = 300
MIN_AGING_LOG_SEGMENT_SECONDS = 1
MAX_AGING_LOG_SEGMENT_SECONDS = 24 * 60 * 60
# Backend action library root (side-by-side with the aging log). Empty = the
# Trajectory action library is disabled. Deployment pins it to $BASE/Trajectory.
DEFAULT_TRAJECTORY_DIR = ""
# MIT position-servo gains per joint (J1..J6 + gripper), aligned with the
# reference hardware config (reBotArm_control/config/rebotarm_rs.yaml). Aging
# motion drives the arm in MIT mode with these kp/kd and tau=0. Overridable via
# REBOT_MIT_KP / REBOT_MIT_KD (comma-separated, exactly seven finite values).
DEFAULT_MIT_KP = (50.0, 150.0, 150.0, 50.0, 50.0, 50.0, 50.0)
DEFAULT_MIT_KD = (3.0, 10.0, 10.0, 5.0, 4.0, 4.0, 4.0)

#: Gravity compensation: when enabled, the aging runtime computes gravity torque
#: from the URDF model and sends it as torque feedforward (tau_ff) in each MIT
#: frame.  Default OFF (fail closed) — existing behaviour is unchanged.
DEFAULT_GRAVITY_COMPENSATION_ENABLE = False
#: Per-joint gravity compensation scaling factors (J1..J7).  Joints 2 (shoulder)
#: and 3 (elbow) are most likely to need adjustment.  Default all-1.0.
DEFAULT_GRAVITY_COMPENSATION_FACTOR = (1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0)

#: Home-verification tolerance (rad).  MIT position servo under gravity/friction
#: leaves a small steady-state residual.  Default 0.05 rad was too tight for some
#: configurations; 0.08 rad is a more forgiving default.
DEFAULT_HOME_TOLERANCE_RAD = 0.08
#: Home-verification failure mode: "warn" logs a warning and continues aging,
#: "stop" raises AgingSafetyFault and aborts the cycle.  Default "warn".
DEFAULT_HOME_VERIFY_MODE = "warn"

#: Require all 7 motor IDs (1..7) to be detected for the scan to report
#: "connected" (default ON = fail closed).  When OFF, a partial scan with
#: at least one motor found is promoted to "connected" so the arm can be
#: used even with missing motors.
DEFAULT_REQUIRE_ALL_MOTORS = True

_VALID_LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
_VALID_HOME_VERIFY_MODES = ("warn", "stop")


class ConfigError(ValueError):
    """Invalid configuration. The service fails closed on these."""


def validate_channel(channel: object) -> str:
    """Return *channel* if it is a safe SocketCAN name, else raise ConfigError."""
    if not isinstance(channel, str) or CHANNEL_PATTERN.fullmatch(channel) is None:
        raise ConfigError(
            "invalid CAN channel %r: only 'can<number>' is allowed (e.g. can0)"
            % (channel,)
        )
    return channel


def _as_bool(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _parse_mit_gains(env_name: str, raw: str, default: tuple[float, ...]) -> tuple[float, ...]:
    """Parse a comma-separated MIT gain list (exactly seven positive values)."""
    if not isinstance(raw, str) or not raw.strip():
        return default
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) != 7 or any(not part for part in parts):
        raise ConfigError(f"{env_name} must contain exactly seven comma-separated values")
    values: list[float] = []
    for part in parts:
        try:
            value = float(part)
        except ValueError:
            raise ConfigError(f"{env_name} contains a non-numeric value {part!r}") from None
        if not math.isfinite(value) or value <= 0.0:
            raise ConfigError(f"{env_name} values must be positive finite numbers")
        values.append(value)
    return tuple(values)


def _parse_sim_found_ids(raw: str) -> tuple[int, ...]:
    ids: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            value = int(part, 10)
        except ValueError:
            raise ConfigError(
                f"REBOT_SIM_FOUND_IDS contains non-integer id {part!r}"
            ) from None
        if value <= 0:
            raise ConfigError(
                f"REBOT_SIM_FOUND_IDS contains invalid motor id {value}"
            )
        ids.add(value)
    return tuple(sorted(ids))


def _parse_cors_origins(raw: str) -> tuple[str, ...]:
    origins = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            origins.append(part)
    return tuple(origins)


@dataclass(frozen=True)
class Settings:
    """Immutable runtime settings."""

    adapter: str = ADAPTER_SIMULATION
    channel: str = DEFAULT_CHANNEL
    expected_ids: tuple[int, ...] = DEFAULT_EXPECTED_MOTOR_IDS
    host_id: int = DEFAULT_HOST_ID
    ping_timeout_ms: int = DEFAULT_PING_TIMEOUT_MS
    telemetry_hz: float = DEFAULT_TELEMETRY_HZ
    #: Authorization for the single permitted motor write
    #: (``robstride_set_active_report``). Default OFF (fail closed).
    allow_active_report_write: bool = DEFAULT_ALLOW_ACTIVE_REPORT_WRITE
    #: Phase 7I manual enable/disable gate; default OFF (fail closed).
    allow_enable_write: bool = DEFAULT_ALLOW_ENABLE_WRITE
    #: Persistent gain write gate; default OFF (fail closed).
    allow_parameter_write: bool = DEFAULT_ALLOW_PARAMETER_WRITE
    #: Phase 7I zero-torque state-machine gate; default OFF (fail closed).
    allow_zero_torque_write: bool = DEFAULT_ALLOW_ZERO_TORQUE_WRITE
    #: Mechanical-zero persistence gate; default OFF (fail closed).
    allow_set_zero_write: bool = DEFAULT_ALLOW_SET_ZERO_WRITE
    #: Backend-owned fixed-speed aging motion gate; default OFF.
    allow_aging_write: bool = DEFAULT_ALLOW_AGING_WRITE
    #: Bounded backend-owned zero-torque command loop frequency.
    zero_torque_hz: float = DEFAULT_ZERO_TORQUE_HZ
    sim_found_ids: tuple[int, ...] = DEFAULT_EXPECTED_MOTOR_IDS
    sim_scan_delay_s: float = 0.0
    sim_fatal_error: bool = False
    cors_origins: tuple[str, ...] = ()
    host: str = DEFAULT_HTTP_HOST
    port: int = DEFAULT_HTTP_PORT
    #: Pre-built web UI directory for optional same-origin static hosting.
    #: Empty string = disabled (default). Validated fail-closed in app.py.
    web_dist_dir: str = DEFAULT_WEB_DIST_DIR
    #: Restricted aging-log root; empty means all aging-log persistence is off.
    aging_log_root: str = DEFAULT_AGING_LOG_ROOT
    aging_log_min_free_bytes: int = DEFAULT_AGING_LOG_MIN_FREE_BYTES
    aging_log_segment_seconds: int = DEFAULT_AGING_LOG_SEGMENT_SECONDS
    #: Backend action-library root (Trajectory); empty means the library is off.
    trajectory_dir: str = DEFAULT_TRAJECTORY_DIR
    #: MIT position-servo gains per joint (J1..J6 + gripper).
    mit_kp: tuple[float, ...] = DEFAULT_MIT_KP
    mit_kd: tuple[float, ...] = DEFAULT_MIT_KD
    #: Gravity compensation enable (default OFF, fail closed).
    gravity_compensation_enable: bool = DEFAULT_GRAVITY_COMPENSATION_ENABLE
    #: Per-joint gravity compensation scaling factors (J1..J7, default all 1.0).
    gravity_compensation_factor: tuple[float, ...] = DEFAULT_GRAVITY_COMPENSATION_FACTOR
    #: Home-verification tolerance (rad).
    home_tolerance_rad: float = DEFAULT_HOME_TOLERANCE_RAD
    #: Home-verification failure mode: "warn" or "stop".
    home_verify_mode: str = DEFAULT_HOME_VERIFY_MODE
    #: Require all 7 motor IDs for scan to report "connected".
    require_all_motors: bool = DEFAULT_REQUIRE_ALL_MOTORS
    log_json: bool = True
    log_level: str = "INFO"


def load_settings(env: Optional[Mapping[str, str]] = None) -> Settings:
    """Load settings from *env* (defaults to ``os.environ``, plus ``.env``).

    Raises :class:`ConfigError` on any invalid value (fail closed).
    """
    if env is None:
        try:
            from dotenv import load_dotenv

            load_dotenv()
        except ImportError:
            pass
        env = os.environ

    def get(name: str, default: str = "") -> str:
        value = env.get(name)
        if value is None or not value.strip():
            return default
        return value.strip()

    adapter = get("REBOT_ADAPTER", ADAPTER_SIMULATION).lower()
    if adapter not in _SUPPORTED_ADAPTERS:
        raise ConfigError(
            f"REBOT_ADAPTER must be one of {_SUPPORTED_ADAPTERS}, got {adapter!r} "
            "(fail closed)"
        )

    channel = validate_channel(get("REBOT_CAN_CHANNEL", DEFAULT_CHANNEL))

    try:
        host_id = int(get("REBOT_HOST_ID", str(DEFAULT_HOST_ID)), 0)  # allows 0xFD
    except ValueError:
        raise ConfigError("REBOT_HOST_ID must be an integer (e.g. 253 or 0xFD)") from None
    if not 0 <= host_id <= 255:
        raise ConfigError("REBOT_HOST_ID must fit in one byte (0..255)")

    try:
        ping_timeout_ms = int(
            get("REBOT_PING_TIMEOUT_MS", str(DEFAULT_PING_TIMEOUT_MS))
        )
    except ValueError:
        raise ConfigError(
            "REBOT_PING_TIMEOUT_MS must be an integer number of milliseconds"
        ) from None
    # Clamp to a safe window: long enough for a real bus reply, short enough
    # that a full 7-ID scan stays bounded (worst case ~14 s).
    ping_timeout_ms = max(MIN_PING_TIMEOUT_MS, min(MAX_PING_TIMEOUT_MS, ping_timeout_ms))

    try:
        telemetry_hz = float(get("REBOT_TELEMETRY_HZ", str(DEFAULT_TELEMETRY_HZ)))
    except ValueError:
        raise ConfigError(
            "REBOT_TELEMETRY_HZ must be a number of frames per second"
        ) from None
    if not math.isfinite(telemetry_hz):
        raise ConfigError("REBOT_TELEMETRY_HZ must be a finite number")
    # Clamp so the WebSocket stream rate is always bounded.
    telemetry_hz = max(MIN_TELEMETRY_HZ, min(MAX_TELEMETRY_HZ, telemetry_hz))

    # The ONE authorized motor write (robstride_set_active_report True/False
    # for telemetry sessions). Explicit opt-in only; default OFF.
    allow_active_report_write = _as_bool(
        get("REBOT_ALLOW_ACTIVE_REPORT_WRITE", "0")
    )

    # Truthy set is 1/true/yes/on (see _as_bool); anything else is OFF.
    allow_enable_write = _as_bool(get("REBOT_ALLOW_ENABLE_WRITE", "0"))
    allow_parameter_write = _as_bool(
        get("REBOT_ALLOW_PARAMETER_WRITE", "0")
    )
    allow_zero_torque_write = _as_bool(
        get("REBOT_ALLOW_ZERO_TORQUE_WRITE", "0")
    )
    allow_set_zero_write = _as_bool(get("REBOT_ALLOW_SET_ZERO_WRITE", "0"))
    allow_aging_write = _as_bool(get("REBOT_ALLOW_AGING_WRITE", "0"))

    try:
        zero_torque_hz = float(
            get("REBOT_ZERO_TORQUE_HZ", str(DEFAULT_ZERO_TORQUE_HZ))
        )
    except ValueError:
        raise ConfigError("REBOT_ZERO_TORQUE_HZ must be a number") from None
    if not math.isfinite(zero_torque_hz):
        raise ConfigError("REBOT_ZERO_TORQUE_HZ must be finite")
    zero_torque_hz = max(MIN_ZERO_TORQUE_HZ, min(MAX_ZERO_TORQUE_HZ, zero_torque_hz))

    found_raw = get("REBOT_SIM_FOUND_IDS")
    sim_found_ids = _parse_sim_found_ids(found_raw) if found_raw else DEFAULT_EXPECTED_MOTOR_IDS

    try:
        sim_scan_delay_s = max(0.0, min(60.0, float(get("REBOT_SIM_SCAN_DELAY_S", "0"))))
    except ValueError:
        raise ConfigError("REBOT_SIM_SCAN_DELAY_S must be a number of seconds") from None

    sim_fatal_error = _as_bool(get("REBOT_SIM_FATAL_ERROR", "0"))

    cors_origins = _parse_cors_origins(get("REBOT_CORS_ORIGINS", ""))

    host = get("REBOT_HOST", DEFAULT_HTTP_HOST)

    # Optional same-origin static hosting (pre-built Vite dist). Default
    # empty = disabled. Existence/shape validation happens at app creation
    # (staticweb.validate_web_root) so a bad value fails closed at startup.
    web_dist_dir = get("REBOT_WEB_DIST_DIR", DEFAULT_WEB_DIST_DIR)

    # Restricted aging-log persistence.  The root is intentionally not
    # defaulted to a writable application directory: empty means disabled.
    aging_log_root = get("REBOT_AGING_LOG_ROOT", DEFAULT_AGING_LOG_ROOT)
    if aging_log_root and not os.path.isabs(aging_log_root):
        raise ConfigError("REBOT_AGING_LOG_ROOT must be an absolute path")
    try:
        aging_log_min_free_bytes = int(
            get(
                "REBOT_AGING_LOG_MIN_FREE_BYTES",
                str(DEFAULT_AGING_LOG_MIN_FREE_BYTES),
            )
        )
    except ValueError:
        raise ConfigError(
            "REBOT_AGING_LOG_MIN_FREE_BYTES must be a non-negative integer"
        ) from None
    if aging_log_min_free_bytes < 0:
        raise ConfigError("REBOT_AGING_LOG_MIN_FREE_BYTES cannot be negative")
    try:
        aging_log_segment_seconds = int(
            get(
                "REBOT_AGING_LOG_SEGMENT_SECONDS",
                str(DEFAULT_AGING_LOG_SEGMENT_SECONDS),
            )
        )
    except ValueError:
        raise ConfigError(
            "REBOT_AGING_LOG_SEGMENT_SECONDS must be an integer"
        ) from None
    if not MIN_AGING_LOG_SEGMENT_SECONDS <= aging_log_segment_seconds <= MAX_AGING_LOG_SEGMENT_SECONDS:
        raise ConfigError(
            "REBOT_AGING_LOG_SEGMENT_SECONDS must be between "
            f"{MIN_AGING_LOG_SEGMENT_SECONDS} and {MAX_AGING_LOG_SEGMENT_SECONDS}"
        )

    # Backend action library (Trajectory). Empty = disabled; when set it must
    # be an absolute path (deployment pins it to $BASE/Trajectory).
    trajectory_dir = get("REBOT_TRAJECTORY_DIR", DEFAULT_TRAJECTORY_DIR)
    if trajectory_dir and not os.path.isabs(trajectory_dir):
        raise ConfigError("REBOT_TRAJECTORY_DIR must be an absolute path")

    # MIT position-servo gains for aging motion (J1..J6 + gripper).
    mit_kp = _parse_mit_gains("REBOT_MIT_KP", get("REBOT_MIT_KP", ""), DEFAULT_MIT_KP)
    mit_kd = _parse_mit_gains("REBOT_MIT_KD", get("REBOT_MIT_KD", ""), DEFAULT_MIT_KD)

    # Gravity compensation: default OFF (fail closed).
    gravity_compensation_enable = _as_bool(
        get("REBOT_GRAVITY_COMPENSATION_ENABLE", "0")
    )
    gravity_compensation_factor = _parse_mit_gains(
        "REBOT_GRAVITY_COMPENSATION_FACTOR",
        get("REBOT_GRAVITY_COMPENSATION_FACTOR", ""),
        DEFAULT_GRAVITY_COMPENSATION_FACTOR,
    )

    try:
        home_tolerance_rad = float(
            get("REBOT_HOME_TOLERANCE_RAD", str(DEFAULT_HOME_TOLERANCE_RAD))
        )
    except ValueError:
        raise ConfigError("REBOT_HOME_TOLERANCE_RAD must be a number") from None
    if not math.isfinite(home_tolerance_rad) or not 0.0 < home_tolerance_rad <= 0.5:
        raise ConfigError("REBOT_HOME_TOLERANCE_RAD must be in (0, 0.5]")

    home_verify_mode = get("REBOT_HOME_VERIFY_MODE", DEFAULT_HOME_VERIFY_MODE).lower()
    if home_verify_mode not in _VALID_HOME_VERIFY_MODES:
        raise ConfigError(
            f"REBOT_HOME_VERIFY_MODE must be one of {_VALID_HOME_VERIFY_MODES}"
        )

    require_all_motors = _as_bool(get("REBOT_REQUIRE_ALL_MOTORS", "1"))

    try:
        port = int(get("REBOT_PORT", str(DEFAULT_HTTP_PORT)))
    except ValueError:
        raise ConfigError("REBOT_PORT must be an integer") from None
    if not 0 < port <= 65535:
        raise ConfigError("REBOT_PORT must be in 1..65535")

    log_json = _as_bool(get("REBOT_LOG_JSON", "1"))
    log_level = get("REBOT_LOG_LEVEL", "INFO").upper()
    if log_level not in _VALID_LOG_LEVELS:
        raise ConfigError(f"REBOT_LOG_LEVEL must be one of {_VALID_LOG_LEVELS}")

    return Settings(
        adapter=adapter,
        channel=channel,
        # Fixed on the backend; an env var or request cannot change this.
        expected_ids=DEFAULT_EXPECTED_MOTOR_IDS,
        host_id=host_id,
        ping_timeout_ms=ping_timeout_ms,
        telemetry_hz=telemetry_hz,
        allow_active_report_write=allow_active_report_write,
        allow_enable_write=allow_enable_write,
        allow_parameter_write=allow_parameter_write,
        allow_zero_torque_write=allow_zero_torque_write,
        allow_set_zero_write=allow_set_zero_write,
        allow_aging_write=allow_aging_write,
        zero_torque_hz=zero_torque_hz,
        sim_found_ids=sim_found_ids,
        sim_scan_delay_s=sim_scan_delay_s,
        sim_fatal_error=sim_fatal_error,
        cors_origins=cors_origins,
        host=host,
        port=port,
        web_dist_dir=web_dist_dir,
        aging_log_root=aging_log_root,
        aging_log_min_free_bytes=aging_log_min_free_bytes,
        aging_log_segment_seconds=aging_log_segment_seconds,
        trajectory_dir=trajectory_dir,
        mit_kp=mit_kp,
        mit_kd=mit_kd,
        gravity_compensation_enable=gravity_compensation_enable,
        gravity_compensation_factor=gravity_compensation_factor,
        home_tolerance_rad=home_tolerance_rad,
        home_verify_mode=home_verify_mode,
        require_all_motors=require_all_motors,
        log_json=log_json,
        log_level=log_level,
    )
