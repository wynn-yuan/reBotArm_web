"""Fail-closed persistence for aging-test artifacts.

This module owns only filesystem persistence. It never reads telemetry or
calls a device adapter; ``AgingRecorder`` feeds it frames produced by the
existing telemetry hub. The root directory is an explicit deployment boundary
(``REBOT_AGING_LOG_ROOT``); an empty root keeps the capability disabled.
"""

from __future__ import annotations

import csv
import json
import math
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional


DEFAULT_MIN_FREE_BYTES = 100 * 1024 * 1024
DEFAULT_SEGMENT_SECONDS = 300
MIN_SEGMENT_SECONDS = 1
MAX_SEGMENT_SECONDS = 24 * 60 * 60

SESSION_JSON = "session.json"
RAW_ACTION_JSON = "raw_action.json"
PROCESSED_ACTION_JSON = "processed_action.json"
EVENTS_JSONL = "events.jsonl"

# Backend action library (Trajectory): a directory of processed arm actions
# that the operating page records into and the aging page executes from. The
# directory (deployment-pinned to $BASE/Trajectory) holds one JSON file per
# action. The library is persistence only; it never asks a device to run
# anything.
_ACTION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

# Stable flat representation of the existing WebSocket telemetry frame.
# The recorder does not perform a second device read; it flattens each joint
# from the exact frame already delivered to live monitoring and trends.
TELEMETRY_FIELDS = (
    "timestamp",
    "sequence",
    "channel",
    "source",
    "motor_id",
    "position",
    "velocity",
    "torque",
    "temperature_mos",
    "temperature_rotor",
    "status_code",
    "freshness",
)
_TELEMETRY_NUMERIC_FIELDS = {
    "sequence",
    "position",
    "velocity",
    "torque",
    "temperature_mos",
    "temperature_rotor",
    "status_code",
}
_SESSION_ID_RE = re.compile(
    r"^[0-9]{8}T[0-9]{6}[0-9]{6}Z_[0-9a-f]{32}$"
)
_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_RESERVED_WINDOWS_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class AgingLogError(RuntimeError):
    """Base error with an HTTP-safe code and status."""

    code = "aging_log_error"
    status_code = 400


class AgingLogDisabledError(AgingLogError):
    code = "aging_logs_disabled"
    status_code = 404


class AgingLogPathError(AgingLogError):
    code = "invalid_aging_log_path"
    status_code = 400


class AgingLogPermissionError(AgingLogError):
    code = "aging_log_not_writable"
    status_code = 503


class AgingLogDiskSpaceError(AgingLogError):
    code = "aging_log_disk_space_low"
    status_code = 507


class AgingLogStorageError(AgingLogError):
    code = "aging_log_storage_error"
    status_code = 503


class AgingLogSessionError(AgingLogError):
    code = "invalid_aging_session"
    status_code = 404


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_relative_subdir(value: str | None) -> str:
    """Validate a normalized, relative slash-separated directory.

    Empty string denotes the configured root.  Backslashes are rejected even
    on POSIX so that the same API input cannot change meaning on Jetson and
    Windows.  Components are intentionally conservative and never include
    ``.`` or ``..``.
    """

    if value is None:
        return ""
    if not isinstance(value, str) or not value:
        if value == "":
            return ""
        raise AgingLogPathError("directory must be a relative path string")
    if "\x00" in value or "\\" in value:
        raise AgingLogPathError("directory must use normalized forward-slash components")
    if value.startswith("/") or os.path.isabs(value):
        raise AgingLogPathError("absolute paths are not accepted")
    # ntpath is needed even when tests run on POSIX: drive-qualified input is
    # still unsafe if the same JSON is later consumed on Windows.
    import ntpath

    drive, _ = ntpath.splitdrive(value)
    if drive or ntpath.isabs(value):
        raise AgingLogPathError("drive-qualified or absolute paths are not accepted")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise AgingLogPathError("directory must be normalized and cannot contain . or ..")
    for part in parts:
        if not _COMPONENT_RE.fullmatch(part):
            raise AgingLogPathError("directory contains an invalid component")
        if part.split(".", 1)[0].upper() in _RESERVED_WINDOWS_NAMES:
            raise AgingLogPathError("directory contains a reserved component")
    return "/".join(parts)


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class SessionInfo:
    session_id: str
    relative_path: str
    directory: str
    created_at: str
    execution_available: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "path": self.relative_path,
            "directory": self.directory,
            "created_at": self.created_at,
            "execution_available": self.execution_available,
        }


class _ThreadLock:
    """Process-local lock shared by all store operations in this process."""

    def __init__(self) -> None:
        self._lock = threading.RLock()

    def __enter__(self):
        self._lock.acquire()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._lock.release()
        return False


class AgingLogStore:
    """Safe root-scoped storage for session metadata and event files."""

    def __init__(
        self,
        root: str | os.PathLike[str] | None = "",
        *,
        min_free_bytes: int = DEFAULT_MIN_FREE_BYTES,
        segment_seconds: int = DEFAULT_SEGMENT_SECONDS,
        trajectory_root: str | os.PathLike[str] | None = "",
    ) -> None:
        raw_root = "" if root is None else os.fspath(root)
        if not isinstance(raw_root, str):
            raise AgingLogPathError("aging log root must be a path string")
        if min_free_bytes < 0:
            raise AgingLogStorageError("minimum free space cannot be negative")
        if not MIN_SEGMENT_SECONDS <= segment_seconds <= MAX_SEGMENT_SECONDS:
            raise AgingLogStorageError("telemetry segment period is outside the safe range")
        self.min_free_bytes = int(min_free_bytes)
        self.segment_seconds = int(segment_seconds)
        self._lock = _ThreadLock()
        self._root: Optional[Path]
        if not raw_root.strip():
            self._root = None
        else:
            root_path = Path(raw_root).expanduser()
            if not root_path.is_absolute():
                raise AgingLogPathError("aging log root must be absolute")
            # The configured root itself is the explicit trust boundary.  A
            # symlink supplied by deployment config is therefore resolved once;
            # symlinks below it are still rejected.
            self._root = root_path.resolve(strict=False)
        # Backend action library (Trajectory) root. Independently enabled from
        # the aging-log root so actions can be managed even when telemetry
        # persistence is off.
        self._trajectory_root: Optional[Path]
        raw_trajectory = "" if trajectory_root is None else os.fspath(trajectory_root)
        if not isinstance(raw_trajectory, str):
            raise AgingLogPathError("trajectory root must be a path string")
        if not raw_trajectory.strip():
            self._trajectory_root = None
        else:
            t_path = Path(raw_trajectory).expanduser()
            if not t_path.is_absolute():
                raise AgingLogPathError("trajectory root must be absolute")
            self._trajectory_root = t_path.resolve(strict=False)

    @property
    def enabled(self) -> bool:
        return self._root is not None

    @property
    def root(self) -> Optional[Path]:
        return self._root

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "root": str(self._root) if self._root is not None else None,
            "min_free_bytes": self.min_free_bytes,
            "segment_seconds": self.segment_seconds,
            "aging_execution_available": False,
            "message": (
                "aging execution is not exposed; this capability only manages files"
            ),
        }

    def _require_enabled(self) -> Path:
        if self._root is None:
            raise AgingLogDisabledError("restricted aging log persistence is disabled")
        return self._root

    def _ensure_root(self) -> Path:
        root = self._require_enabled()
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise AgingLogPermissionError(f"cannot create aging log root: {exc}") from None
        if not root.is_dir():
            raise AgingLogPermissionError("aging log root is not a directory")
        return root

    def _safe_path(self, relative: str, *, must_exist: bool = False) -> Path:
        root = self._ensure_root()
        normalized = normalize_relative_subdir(relative)
        candidate = root.joinpath(*normalized.split("/")) if normalized else root
        current = root
        for part in normalized.split("/") if normalized else ():
            current = current / part
            if current.is_symlink():
                raise AgingLogPathError("symlink components are not accepted")
        resolved = candidate.resolve(strict=False)
        if not _is_within(resolved, root):
            raise AgingLogPathError("path escapes the configured aging log root")
        if must_exist and not candidate.exists():
            raise AgingLogSessionError("aging session does not exist")
        if candidate.is_symlink():
            raise AgingLogPathError("symlink paths are not accepted")
        return candidate

    def _check_writable_and_space(self, directory: Path) -> None:
        if not os.access(directory, os.W_OK | os.X_OK):
            raise AgingLogPermissionError("aging log directory is not writable")
        probe = directory / f".aging-write-probe-{uuid.uuid4().hex}"
        try:
            with open(probe, "xb") as handle:
                handle.write(b"ok")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            raise AgingLogPermissionError(f"aging log directory is not writable: {exc}") from None
        finally:
            try:
                probe.unlink()
            except FileNotFoundError:
                pass
            except OSError as exc:
                raise AgingLogPermissionError(f"cannot clean write probe: {exc}") from None
        try:
            free = shutil.disk_usage(directory).free
        except OSError as exc:
            raise AgingLogStorageError(f"cannot inspect aging log disk space: {exc}") from None
        if free < self.min_free_bytes:
            raise AgingLogDiskSpaceError(
                f"aging log disk free space {free} is below the configured minimum "
                f"{self.min_free_bytes}"
            )

    def list_directories(self, relative: str = "") -> list[str]:
        with self._lock:
            target = self._safe_path(relative)
            if not target.exists():
                return []
            if not target.is_dir():
                raise AgingLogPathError("directory target is not a directory")
            result = []
            for child in target.iterdir():
                if child.is_symlink():
                    continue
                if child.is_dir():
                    result.append(child.name)
            return sorted(result)

    def create_directory(self, relative: str = "") -> str:
        normalized = normalize_relative_subdir(relative)
        with self._lock:
            root = self._ensure_root()
            target = self._safe_path(normalized)
            self._check_writable_and_space(root)
            current = root
            for part in normalized.split("/") if normalized else ():
                current = current / part
                if current.is_symlink():
                    raise AgingLogPathError("symlink components are not accepted")
                try:
                    current.mkdir()
                except FileExistsError:
                    if current.is_symlink() or not current.is_dir():
                        raise AgingLogPathError("directory component is not a real directory") from None
            return normalized

    def _new_session_id(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "_" + uuid.uuid4().hex

    @staticmethod
    def _atomic_json(path: Path, payload: Any) -> None:
        try:
            encoded = json.dumps(
                payload,
                ensure_ascii=False,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise AgingLogStorageError(f"JSON payload is not serializable: {exc}") from None
        temporary: Optional[Path] = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=path.parent,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                handle.write(encoded)
                handle.write(b"\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            temporary = None
        except OSError as exc:
            raise AgingLogStorageError(f"cannot atomically write {path.name}: {exc}") from None
        finally:
            if temporary is not None:
                try:
                    temporary.unlink()
                except FileNotFoundError:
                    pass

    @staticmethod
    def _create_empty_events(path: Path) -> None:
        try:
            with open(path, "xb") as handle:
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            raise AgingLogStorageError("session events file already exists") from None
        except OSError as exc:
            raise AgingLogStorageError(f"cannot create {EVENTS_JSONL}: {exc}") from None

    def create_session(
        self,
        directory: str = "",
        *,
        session: Optional[Mapping[str, Any]] = None,
        raw_action: Optional[Any] = None,
        processed_action: Optional[Any] = None,
    ) -> SessionInfo:
        normalized_directory = normalize_relative_subdir(directory)
        if session is not None and not isinstance(session, Mapping):
            raise AgingLogStorageError("session metadata must be a JSON object")
        with self._lock:
            root = self._ensure_root()
            base = self._safe_path(normalized_directory)
            if base.exists() and not base.is_dir():
                raise AgingLogPathError("session directory is not a directory")
            if not base.exists():
                self.create_directory(normalized_directory)
            # Check the actual session parent as well as the configured root:
            # a nested directory can be mounted or permissioned differently.
            self._check_writable_and_space(base)
            for _ in range(20):
                session_id = self._new_session_id()
                candidate = base / session_id
                if candidate.exists() or candidate.is_symlink():
                    continue
                try:
                    candidate.mkdir()
                except FileExistsError:
                    continue
                try:
                    created_at = utc_now_iso()
                    relative_path = f"{normalized_directory}/{session_id}" if normalized_directory else session_id
                    metadata = dict(session or {})
                    metadata.update(
                        {
                            "session_id": session_id,
                            "path": relative_path,
                            "created_at": created_at,
                            "execution_available": False,
                        }
                    )
                    self._atomic_json(candidate / SESSION_JSON, metadata)
                    self._atomic_json(candidate / RAW_ACTION_JSON, {} if raw_action is None else raw_action)
                    self._atomic_json(
                        candidate / PROCESSED_ACTION_JSON,
                        {} if processed_action is None else processed_action,
                    )
                    self._create_empty_events(candidate / EVENTS_JSONL)
                    return SessionInfo(
                        session_id=session_id,
                        relative_path=relative_path,
                        directory=normalized_directory,
                        created_at=created_at,
                    )
                except Exception:
                    self._cleanup_new_session(candidate, root)
                    raise
            raise AgingLogStorageError("could not allocate a unique aging session directory")

    def _session_dir(self, session_path: str) -> Path:
        normalized = normalize_relative_subdir(session_path)
        if not normalized:
            raise AgingLogSessionError("session path is required")
        session_id = normalized.rsplit("/", 1)[-1]
        if _SESSION_ID_RE.fullmatch(session_id) is None:
            raise AgingLogSessionError("invalid aging session id")
        target = self._safe_path(normalized, must_exist=True)
        if not target.is_dir():
            raise AgingLogSessionError("aging session is not a directory")
        if not (target / SESSION_JSON).is_file() or (target / SESSION_JSON).is_symlink():
            raise AgingLogSessionError("aging session manifest is missing")
        return target

    def _cleanup_new_session(self, candidate: Path, root: Path) -> None:
        try:
            resolved = candidate.resolve(strict=False)
            if _is_within(resolved, root) and candidate.is_dir() and not candidate.is_symlink():
                shutil.rmtree(candidate)
        except OSError:
            # The original storage exception is more useful than cleanup
            # noise.  Cleanup never follows a symlink or leaves the root.
            pass

    def write_session_json(self, session_path: str, filename: str, payload: Any) -> None:
        if filename not in {SESSION_JSON, RAW_ACTION_JSON, PROCESSED_ACTION_JSON}:
            raise AgingLogPathError("only session.json, raw_action.json and processed_action.json are writable")
        with self._lock:
            session_dir = self._session_dir(session_path)
            target = session_dir / filename
            if target.is_symlink():
                raise AgingLogPathError("session file symlinks are not accepted")
            self._atomic_json(target, payload)

    def append_event(self, session_path: str, event: Mapping[str, Any]) -> None:
        if not isinstance(event, Mapping):
            raise AgingLogStorageError("event must be a JSON object")
        try:
            line = json.dumps(
                dict(event), ensure_ascii=False, allow_nan=False, separators=(",", ":")
            ) + "\n"
        except (TypeError, ValueError) as exc:
            raise AgingLogStorageError(f"event is not serializable: {exc}") from None
        with self._lock:
            session_dir = self._session_dir(session_path)
            target = session_dir / EVENTS_JSONL
            if target.is_symlink():
                raise AgingLogPathError("events file symlinks are not accepted")
            try:
                with open(target, "a", encoding="utf-8", newline="") as handle:
                    handle.write(line)
                    handle.flush()
                    os.fsync(handle.fileno())
            except OSError as exc:
                raise AgingLogStorageError(f"cannot append {EVENTS_JSONL}: {exc}") from None

    def telemetry_writer(self, session_path: str) -> "TelemetryCsvSegmentWriter":
        with self._lock:
            session_dir = self._session_dir(session_path)
        return TelemetryCsvSegmentWriter(session_dir, self.segment_seconds, self._lock)

    # Friendly alias for callers that prefer an explicit factory name.
    create_telemetry_writer = telemetry_writer

    # ---------- Backend action library (Trajectory) ----------

    @property
    def trajectory_enabled(self) -> bool:
        return self._trajectory_root is not None

    @property
    def trajectory_root(self) -> Optional[Path]:
        return self._trajectory_root

    def _require_trajectory_root(self) -> Path:
        root = self._trajectory_root
        if root is None:
            raise AgingLogDisabledError("Trajectory action library is disabled")
        if root.is_symlink():
            raise AgingLogPathError("Trajectory root symlinks are not accepted")
        try:
            root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise AgingLogPermissionError(
                f"cannot create Trajectory directory: {exc}"
            ) from None
        if not root.is_dir():
            raise AgingLogPermissionError("Trajectory directory is not a directory")
        return root

    @staticmethod
    def _action_id(action_id: Any) -> str:
        if not isinstance(action_id, str) or _ACTION_ID_RE.fullmatch(action_id) is None:
            raise AgingLogPathError("action id must match the safe component pattern")
        return action_id

    @staticmethod
    def _read_action_file(path: Path) -> dict[str, Any]:
        if path.is_symlink():
            raise AgingLogPathError("action file symlinks are not accepted")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise AgingLogSessionError("trajectory action does not exist") from None
        except (OSError, ValueError) as exc:
            raise AgingLogStorageError(f"cannot read trajectory action: {exc}") from None
        if not isinstance(payload, dict):
            raise AgingLogStorageError("trajectory action file must contain a JSON object")
        return payload

    def list_actions(self) -> list[dict[str, Any]]:
        """Return every action stored in the Trajectory directory.

        A corrupt or unreadable action file is skipped rather than failing the
        whole list; the library is a persistence aid, not a session record.
        """
        with self._lock:
            directory = self._require_trajectory_root()
            result: list[dict[str, Any]] = []
            for child in sorted(directory.iterdir()):
                if child.is_symlink() or not child.is_file() or child.suffix != ".json":
                    continue
                try:
                    payload = json.loads(child.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(payload, dict):
                    result.append(payload)
            return result

    def get_action(self, action_id: str) -> dict[str, Any]:
        """Read one stored action by id (used by the aging runtime to execute)."""
        action_id = self._action_id(action_id)
        with self._lock:
            directory = self._require_trajectory_root()
            return self._read_action_file(directory / f"{action_id}.json")

    def save_action(self, action: Mapping[str, Any]) -> dict[str, Any]:
        action_id = self._action_id(action.get("id"))
        with self._lock:
            directory = self._require_trajectory_root()
            self._check_writable_and_space(directory)
            target = directory / f"{action_id}.json"
            if target.is_symlink():
                raise AgingLogPathError("action file symlinks are not accepted")
            self._atomic_json(target, dict(action))
            return dict(action)

    def delete_action(self, action_id: str) -> None:
        action_id = self._action_id(action_id)
        with self._lock:
            directory = self._require_trajectory_root()
            target = directory / f"{action_id}.json"
            if target.is_symlink():
                raise AgingLogPathError("action file symlinks are not accepted")
            try:
                target.unlink()
            except FileNotFoundError:
                raise AgingLogSessionError("trajectory action does not exist") from None


class TelemetryCsvSegmentWriter:
    """Append-only, fixed-schema CSV writer with generated segment names."""

    def __init__(self, session_dir: Path, segment_seconds: int, lock: _ThreadLock) -> None:
        self._session_dir = session_dir
        self._segment_seconds = segment_seconds
        self._lock = lock
        self._handle = None
        self._writer = None
        self._segment_key: Optional[int] = None
        self._closed = False

    @staticmethod
    def _validate_row(row: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(row, Mapping):
            raise AgingLogStorageError("telemetry row must be an object")
        unknown = set(row) - set(TELEMETRY_FIELDS)
        if unknown:
            raise AgingLogStorageError(f"unsupported telemetry fields: {sorted(unknown)!r}")
        if "timestamp" not in row or "motor_id" not in row:
            raise AgingLogStorageError("telemetry row requires timestamp and motor_id")
        result = {field: row.get(field) for field in TELEMETRY_FIELDS}
        if not isinstance(result["timestamp"], str) or not result["timestamp"]:
            raise AgingLogStorageError("telemetry timestamp must be a non-empty string")
        if not isinstance(result["motor_id"], int) or isinstance(result["motor_id"], bool) or result["motor_id"] <= 0:
            raise AgingLogStorageError("telemetry motor_id must be a positive integer")
        for field in _TELEMETRY_NUMERIC_FIELDS:
            value = result[field]
            if value is None:
                continue
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
                raise AgingLogStorageError(f"telemetry field {field!r} must be a finite number or null")
        return result

    def _open_segment(self, key: int) -> None:
        if self._handle is not None:
            self._handle.flush()
            os.fsync(self._handle.fileno())
            self._handle.close()
        filename = f"telemetry_{key:020d}.csv"
        target = self._session_dir / filename
        if target.is_symlink():
            raise AgingLogPathError("telemetry segment symlinks are not accepted")
        try:
            self._handle = open(target, "a+", encoding="utf-8", newline="")
            self._handle.seek(0, os.SEEK_END)
            if self._handle.tell() == 0:
                self._writer = csv.DictWriter(self._handle, fieldnames=list(TELEMETRY_FIELDS), extrasaction="raise")
                self._writer.writeheader()
                self._handle.flush()
                os.fsync(self._handle.fileno())
            else:
                self._handle.seek(0)
                header = next(csv.reader(self._handle), None)
                if header != list(TELEMETRY_FIELDS):
                    raise AgingLogStorageError(f"telemetry segment {filename} has an invalid header")
                self._handle.seek(0, os.SEEK_END)
                self._writer = csv.DictWriter(self._handle, fieldnames=list(TELEMETRY_FIELDS), extrasaction="raise")
        except OSError as exc:
            raise AgingLogStorageError(f"cannot open telemetry segment {filename}: {exc}") from None
        self._segment_key = key

    def append(self, row: Mapping[str, Any], *, now: Optional[float] = None) -> Path:
        return self.append_many((row,), now=now)

    def append_many(self, rows, *, now: Optional[float] = None) -> Path:
        """Append one telemetry frame and flush it with a single fsync.

        A frame normally contains seven motor rows.  Batching prevents seven
        synchronous disk flushes from stealing time from the 50 Hz control
        loop while retaining crash-durable frame boundaries.
        """
        with self._lock:
            if self._closed:
                raise AgingLogStorageError("telemetry writer is closed")
            validated_rows = [self._validate_row(row) for row in rows]
            if not validated_rows:
                raise AgingLogStorageError("telemetry batch cannot be empty")
            moment = time.time() if now is None else float(now)
            if not math.isfinite(moment) or moment < 0:
                raise AgingLogStorageError("telemetry segment time must be finite and non-negative")
            key = int(moment // self._segment_seconds)
            if key != self._segment_key:
                self._open_segment(key)
            self._writer.writerows(validated_rows)
            self._handle.flush()
            os.fsync(self._handle.fileno())
            return self._session_dir / f"telemetry_{key:020d}.csv"

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            if self._handle is not None:
                self._handle.flush()
                os.fsync(self._handle.fileno())
                self._handle.close()
                self._handle = None
                self._writer = None
            self._closed = True

    def __enter__(self) -> "TelemetryCsvSegmentWriter":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


# Explicitly named alias for downstream code and tests.
TelemetryCsvWriter = TelemetryCsvSegmentWriter
