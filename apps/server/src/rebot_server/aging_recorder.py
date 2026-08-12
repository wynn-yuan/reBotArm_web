"""Persist the existing telemetry stream only while an aging session is active.

This recorder never reads CAN, owns a Controller, or asks a motor for state.
The telemetry hub passes it the exact frame already published to WebSocket
clients. Disk I/O runs on a dedicated bounded worker queue so it cannot stall
the 10 Hz telemetry emitter.
"""

from __future__ import annotations

import queue
import threading
from typing import Any, Mapping, Optional

from .aging_logs import AgingLogStore
from .models import utc_now_iso


class AgingRecorderError(RuntimeError):
    code = "aging_recorder_error"
    status_code = 409


class AgingRecorderUnavailable(AgingRecorderError):
    code = "aging_recording_unavailable"
    status_code = 503


class AgingRecorderBusy(AgingRecorderError):
    code = "aging_recording_active"
    status_code = 409


class AgingRecorder:
    """Thread-safe lifecycle and non-blocking frame sink."""

    def __init__(self, store: AgingLogStore, *, queue_capacity: int = 256) -> None:
        self._store = store
        self._queue_capacity = queue_capacity
        self._lock = threading.RLock()
        self._queue: Optional[queue.Queue] = None
        self._thread: Optional[threading.Thread] = None
        self._session_path: Optional[str] = None
        self._status = "inactive"
        self._started_at: Optional[str] = None
        self._updated_at = utc_now_iso()
        self._frames_written = 0
        self._rows_written = 0
        self._error: Optional[str] = None

    @property
    def available(self) -> bool:
        return self._store.enabled

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "available": self.available,
                "status": self._status,
                "session_path": self._session_path,
                "started_at": self._started_at,
                "updated_at": self._updated_at,
                "frames_written": self._frames_written,
                "rows_written": self._rows_written,
                "error": self._error,
                "root": str(self._store.root) if self._store.root else None,
                "message": "records the existing telemetry stream; no additional CAN reads",
            }

    def start(
        self,
        metadata: Optional[Mapping[str, Any]] = None,
        *,
        processed_action: Any = None,
    ) -> dict[str, Any]:
        if not self.available:
            raise AgingRecorderUnavailable("aging log directory is not configured")
        with self._lock:
            if self._thread is not None or self._status in {"starting", "recording", "stopping"}:
                raise AgingRecorderBusy("an aging recording session is already active")
            self._status = "starting"
            self._updated_at = utc_now_iso()
            self._error = None
        try:
            info = self._store.create_session(
                session={"kind": "aging_telemetry", **dict(metadata or {})},
                processed_action=processed_action if processed_action is not None else {},
            )
        except Exception as exc:
            with self._lock:
                self._status = "error"
                self._error = f"{type(exc).__name__}: {exc}"
                self._updated_at = utc_now_iso()
            raise
        work_queue: queue.Queue = queue.Queue(maxsize=self._queue_capacity)
        thread = threading.Thread(
            target=self._writer_loop,
            args=(info.relative_path, work_queue),
            name="rebot-aging-log-writer",
            daemon=True,
        )
        try:
            self._store.append_event(info.relative_path, {"at": utc_now_iso(), "type": "started"})
        except Exception as exc:
            with self._lock:
                self._status = "error"
                self._error = f"{type(exc).__name__}: {exc}"
                self._updated_at = utc_now_iso()
                self._queue = None
                self._thread = None
            raise
        with self._lock:
            self._queue = work_queue
            self._thread = thread
            self._session_path = info.relative_path
            self._started_at = utc_now_iso()
            self._updated_at = self._started_at
            self._frames_written = 0
            self._rows_written = 0
            self._status = "recording"
        try:
            thread.start()
        except Exception as exc:
            with self._lock:
                self._status = "error"
                self._error = f"{type(exc).__name__}: {exc}"
                self._updated_at = utc_now_iso()
                self._queue = None
                self._thread = None
            raise
        return self.status()

    def accept_frame(self, frame: Mapping[str, Any]) -> None:
        """Non-blocking sink called by the existing telemetry emitter."""
        with self._lock:
            if self._status != "recording" or self._queue is None:
                return
            target = self._queue
        # Copy only JSON-shaped frame data before crossing the thread boundary.
        snapshot = {
            "timestamp": frame.get("timestamp"),
            "sequence": frame.get("sequence"),
            "channel": frame.get("channel"),
            "source": frame.get("source"),
            "joints": [dict(joint) for joint in frame.get("joints", [])],
        }
        try:
            target.put_nowait(snapshot)
        except queue.Full:
            self._fail("telemetry log queue is full; recording stopped to avoid silent data loss")

    def stop(self) -> dict[str, Any]:
        with self._lock:
            if self._status == "inactive":
                return self.status()
            if self._status == "error" and self._thread is None:
                return self.status()
            self._status = "stopping"
            self._updated_at = utc_now_iso()
            target = self._queue
            thread = self._thread
        if target is not None:
            try:
                target.put(None, timeout=1.0)
            except queue.Full:
                self._fail("telemetry log queue did not drain while stopping")
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5.0)
        if thread is not None and thread.is_alive():
            self._fail("telemetry log writer did not stop within five seconds")
        return self.status()

    def shutdown(self) -> None:
        self.stop()

    def _writer_loop(self, session_path: str, work_queue: queue.Queue) -> None:
        writer = self._store.telemetry_writer(session_path)
        error: Optional[str] = None
        try:
            while True:
                frame = work_queue.get()
                if frame is None:
                    break
                rows = self._rows_from_frame(frame)
                writer.append_many(rows)
                with self._lock:
                    self._frames_written += 1
                    self._rows_written += len(rows)
                    self._updated_at = utc_now_iso()
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
        finally:
            try:
                writer.close()
            except Exception as exc:
                error = error or f"{type(exc).__name__}: {exc}"
            try:
                self._store.append_event(
                    session_path,
                    {"at": utc_now_iso(), "type": "stopped", "error": error},
                )
            except Exception as exc:
                error = error or f"{type(exc).__name__}: {exc}"
            with self._lock:
                final_error = error or self._error
                self._status = "error" if final_error else "inactive"
                self._error = final_error
                self._updated_at = utc_now_iso()
                self._queue = None
                self._thread = None

    def _fail(self, message: str) -> None:
        with self._lock:
            self._status = "error"
            self._error = message
            self._updated_at = utc_now_iso()
            target = self._queue
        if target is not None:
            try:
                target.put_nowait(None)
            except queue.Full:
                # Remove one unwritten frame so the terminal marker can stop
                # the worker. The explicit error prevents claiming a complete log.
                try:
                    target.get_nowait()
                    target.put_nowait(None)
                except queue.Empty:
                    pass

    @staticmethod
    def _rows_from_frame(frame: Mapping[str, Any]) -> list[dict[str, Any]]:
        timestamp = frame.get("timestamp")
        sequence = frame.get("sequence")
        joints = frame.get("joints")
        if not isinstance(timestamp, str) or not timestamp or not isinstance(joints, list):
            raise AgingRecorderError("invalid telemetry frame")
        rows = []
        for joint in joints:
            if not isinstance(joint, Mapping):
                raise AgingRecorderError("invalid telemetry joint")
            temperature = joint.get("temperature")
            temp_mos = temperature.get("mos") if isinstance(temperature, Mapping) else None
            temp_rotor = temperature.get("rotor") if isinstance(temperature, Mapping) else None
            rows.append({
                "timestamp": timestamp,
                "sequence": sequence,
                "channel": frame.get("channel"),
                "source": frame.get("source"),
                "motor_id": joint.get("id"),
                "position": joint.get("position"),
                "velocity": joint.get("velocity"),
                "torque": joint.get("torque"),
                "temperature_mos": temp_mos,
                "temperature_rotor": temp_rotor,
                "status_code": joint.get("status_code"),
                "freshness": joint.get("freshness"),
            })
        if len(rows) != 7:
            raise AgingRecorderError("telemetry frame must contain exactly seven joints")
        return rows
