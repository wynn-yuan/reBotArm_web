"""Fail-closed user-confirmed write APIs.

Manual enable/disable, verified persistent gains, and the backend-owned
zero-torque state machine all reuse the Controller created by
:mod:`rebot_server.service` during a full connection scan; this module never
creates a second Controller on can1.
"""

from __future__ import annotations

import threading
import math
from contextlib import contextmanager
from typing import Any, Dict, Iterator, Sequence

from .config import ADAPTER_MOTORBRIDGE, Settings
from .models import STATUS_CONNECTED, utc_now_iso
from .service import (
    BusBusyError,
    ScanInProgressError,
    ServiceOperationError,
    ZeroTorqueBusyError,
)


class WriteOpError(Exception):
    status_code = 500
    code = "write_error"


class WriteNotAuthorizedError(WriteOpError):
    status_code = 403
    code = "write_not_authorized"


class SimulationAdapterError(WriteOpError):
    status_code = 400
    code = "adapter_not_motorbridge"


class RequiresConnectedError(WriteOpError):
    status_code = 409
    code = "requires_connected"


class WriteInProgressError(WriteOpError):
    status_code = 409
    code = "write_in_progress"


class SdkOpFailedError(WriteOpError):
    status_code = 502
    code = "sdk_operation_failed"


class ParameterNotAuthorizedError(WriteOpError):
    status_code = 403
    code = "parameter_write_not_authorized"


class InvalidParameterError(WriteOpError):
    status_code = 422
    code = "invalid_parameter"


class ZeroTorqueNotAuthorizedError(WriteOpError):
    status_code = 403
    code = "zero_torque_not_authorized"


class SetZeroNotAuthorizedError(WriteOpError):
    status_code = 403
    code = "set_zero_not_authorized"


class WriteController:
    """One long-lived gate around the service's single Controller owner."""

    ALLOWED_ACTIONS = frozenset({"enable_all", "disable_all"})
    MAX_GAIN = 500.0

    def __init__(self, settings: Settings, service: Any) -> None:
        self._settings = settings
        self._service = service
        self._op_lock = threading.Lock()

    def enable_all(self) -> Dict[str, Any]:
        return self._run("enable_all")

    def disable_all(self) -> Dict[str, Any]:
        return self._run("disable_all")

    def zero_torque_status(self) -> Dict[str, Any]:
        return self._service.zero_torque_status()

    def start_zero_torque(self) -> Dict[str, Any]:
        with self._zero_gate("start"):
            try:
                return self._service.run_zero_torque_start()
            except (BusBusyError, ScanInProgressError, ZeroTorqueBusyError) as exc:
                raise WriteInProgressError(str(exc)) from None
            except ServiceOperationError as exc:
                raise SdkOpFailedError(str(exc)) from None

    def stop_zero_torque(self) -> Dict[str, Any]:
        with self._zero_gate("stop", allow_inactive=True):
            try:
                return self._service.run_zero_torque_stop()
            except (BusBusyError, ScanInProgressError, ZeroTorqueBusyError) as exc:
                raise WriteInProgressError(str(exc)) from None
            except ServiceOperationError as exc:
                raise SdkOpFailedError(str(exc)) from None

    def write_persistent_gains(self, changes: Sequence[Any]) -> Dict[str, Any]:
        normalized = self._validate_gain_changes(changes)
        with self._parameter_gate():
            try:
                result = self._service.run_parameter_write(normalized)
            except (BusBusyError, ScanInProgressError, ZeroTorqueBusyError) as exc:
                raise WriteInProgressError(str(exc)) from None
            except ServiceOperationError as exc:
                raise SdkOpFailedError(str(exc)) from None
        return {**result, "requested_by": "manual_user", "completed_at": utc_now_iso()}

    def set_zero(self) -> Dict[str, Any]:
        with self._set_zero_gate():
            try:
                result = self._service.run_set_zero()
            except (BusBusyError, ScanInProgressError, ZeroTorqueBusyError) as exc:
                raise WriteInProgressError(str(exc)) from None
            except ServiceOperationError as exc:
                raise SdkOpFailedError(str(exc)) from None
        return {**result, "requested_by": "manual_user", "completed_at": utc_now_iso()}

    def _run(self, action: str) -> Dict[str, Any]:
        if action not in self.ALLOWED_ACTIONS:
            raise SdkOpFailedError("manual action is not allow-listed")
        with self._gate(action):
            try:
                result = self._service.run_manual_action(action)
            except (BusBusyError, ScanInProgressError) as exc:
                raise WriteInProgressError(str(exc)) from None
            except ServiceOperationError as exc:
                raise SdkOpFailedError(str(exc)) from None
        return {**result, "requested_by": "manual_user", "completed_at": utc_now_iso()}

    def _validate_gain_changes(self, changes: Sequence[Any]) -> list[Dict[str, float]]:
        if not changes or len(changes) > len(self._settings.expected_ids):
            raise InvalidParameterError("changes must contain 1..7 motor IDs")
        ids = []
        normalized = []
        expected = set(self._settings.expected_ids)
        for item in changes:
            try:
                motor_id = int(item.motor_id)
                kp = float(item.kp)
                kd = float(item.kd)
            except (AttributeError, TypeError, ValueError):
                raise InvalidParameterError("motor_id, kp and kd are required numbers") from None
            if motor_id not in expected or motor_id in ids:
                raise InvalidParameterError("motor_id must be unique and fixed to 1..7")
            if not math.isfinite(kp) or not math.isfinite(kd):
                raise InvalidParameterError("kp and kd must be finite")
            if not 0.0 <= kp <= self.MAX_GAIN or not 0.0 <= kd <= self.MAX_GAIN:
                raise InvalidParameterError(
                    f"persistent gains must be within 0..{self.MAX_GAIN:g}"
                )
            ids.append(motor_id)
            normalized.append({"motor_id": motor_id, "kp": kp, "kd": kd})
        return sorted(normalized, key=lambda c: c["motor_id"])

    @contextmanager
    def _parameter_gate(self) -> Iterator[None]:
        if not self._settings.allow_parameter_write:
            raise ParameterNotAuthorizedError(
                "persistent parameter writes disabled by REBOT_ALLOW_PARAMETER_WRITE=0"
            )
        if self._settings.adapter != ADAPTER_MOTORBRIDGE:
            raise SimulationAdapterError(
                "persistent parameter writes are available only for motorbridge"
            )
        self._require_connected("persistent parameter write")
        if self._service.zero_torque_status()["status"] in {"starting", "active", "stopping"}:
            raise WriteInProgressError("exit zero-torque mode before writing parameters")
        if not self._op_lock.acquire(blocking=False):
            raise WriteInProgressError("another write request is in progress")
        try:
            yield
        finally:
            self._op_lock.release()

    @contextmanager
    def _zero_gate(self, action: str, *, allow_inactive: bool = False) -> Iterator[None]:
        if not self._settings.allow_zero_torque_write:
            raise ZeroTorqueNotAuthorizedError(
                "zero-torque mode disabled by REBOT_ALLOW_ZERO_TORQUE_WRITE=0"
            )
        if self._settings.adapter != ADAPTER_MOTORBRIDGE:
            raise SimulationAdapterError("zero-torque mode is available only for motorbridge")
        status = self._service.zero_torque_status()["status"]
        if action == "start" and status in {"starting", "active", "stopping"}:
            yield
            return
        if action == "stop" and not allow_inactive and status == "inactive":
            raise RequiresConnectedError("zero-torque mode is not active")
        if action == "stop" and status == "inactive":
            yield
            return
        self._require_connected("zero-torque mode")
        if not self._op_lock.acquire(blocking=False):
            raise WriteInProgressError("another write request is in progress")
        try:
            yield
        finally:
            self._op_lock.release()

    @contextmanager
    def _set_zero_gate(self) -> Iterator[None]:
        if not self._settings.allow_set_zero_write:
            raise SetZeroNotAuthorizedError(
                "mechanical-zero writes disabled by REBOT_ALLOW_SET_ZERO_WRITE=0"
            )
        if self._settings.adapter != ADAPTER_MOTORBRIDGE:
            raise SimulationAdapterError("mechanical zero is available only for motorbridge")
        self._require_connected("mechanical-zero operation")
        if self._service.zero_torque_status()["status"] in {"starting", "active", "stopping"}:
            raise WriteInProgressError("exit zero-torque mode before setting mechanical zero")
        if not self._op_lock.acquire(blocking=False):
            raise WriteInProgressError("another write request is in progress")
        try:
            yield
        finally:
            self._op_lock.release()

    def _require_connected(self, operation: str) -> None:
        snapshot = self._service.snapshot()
        if snapshot.get("status") != STATUS_CONNECTED or set(snapshot.get("found_ids") or ()) != set(self._settings.expected_ids):
            raise RequiresConnectedError(
                f"{operation} requires a completed full scan of motor IDs 1..7"
            )

    @contextmanager
    def _gate(self, action: str) -> Iterator[None]:
        if not self._settings.allow_enable_write:
            raise WriteNotAuthorizedError(
                f"{action} disabled by REBOT_ALLOW_ENABLE_WRITE=0; no motor was touched"
            )
        if self._settings.adapter != ADAPTER_MOTORBRIDGE:
            raise SimulationAdapterError(
                "manual enable/disable is available only for motorbridge; no motor was touched"
            )
        self._require_connected(action)
        if self._service.zero_torque_status()["status"] in {"starting", "active", "stopping"}:
            raise WriteInProgressError("exit zero-torque mode before enable/disable")
        if not self._op_lock.acquire(blocking=False):
            raise WriteInProgressError("another manual enable/disable request is in progress")
        try:
            yield
        finally:
            self._op_lock.release()


__all__ = [
    "WriteController",
    "WriteOpError",
    "WriteNotAuthorizedError",
    "SimulationAdapterError",
    "RequiresConnectedError",
    "WriteInProgressError",
    "SdkOpFailedError",
    "ParameterNotAuthorizedError",
    "InvalidParameterError",
    "ZeroTorqueNotAuthorizedError",
    "SetZeroNotAuthorizedError",
]
