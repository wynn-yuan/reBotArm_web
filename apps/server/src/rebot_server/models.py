"""Domain model for scan / connection state.

This module intentionally uses only the Python standard library so the core
can be tested without FastAPI, pydantic, or any CAN dependency installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Optional

STATUS_DISCONNECTED = "disconnected"
STATUS_SCANNING = "scanning"
STATUS_CONNECTED = "connected"
STATUS_PARTIAL = "partial"
STATUS_ERROR = "error"

ALL_STATUSES = (
    STATUS_DISCONNECTED,
    STATUS_SCANNING,
    STATUS_CONNECTED,
    STATUS_PARTIAL,
    STATUS_ERROR,
)

#: The seven motor IDs expected on can0 (J1..J6 + gripper). Fixed backend
#: constant; never taken from a request.
EXPECTED_MOTOR_IDS: tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7)


def utc_now_iso() -> str:
    """Current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ScanOutcome:
    """What an adapter observed during one scan attempt.

    * ``found_ids`` — motor IDs whose ping reply echoed the *correct* ID.
    * ``errors`` — sanitized per-motor error messages (never stack traces).
    * ``fatal_message`` — set when the scan itself could not be performed
      or complete (SDK missing, channel unusable, aborted). The service maps
      this to status ``error``.
    """

    found_ids: tuple[int, ...] = ()
    errors: Dict[int, str] = field(default_factory=dict)
    fatal_message: Optional[str] = None


@dataclass(frozen=True)
class ScanState:
    """Immutable snapshot of the connection state (the public API shape)."""

    status: str
    channel: str
    expected_ids: tuple[int, ...]
    found_ids: tuple[int, ...]
    missing_ids: tuple[int, ...]
    started_at: Optional[str]
    completed_at: Optional[str]
    source: Optional[str]
    message: Optional[str]

    def to_dict(self) -> dict:
        """JSON-ready representation matching the public API contract."""
        return {
            "status": self.status,
            "channel": self.channel,
            "expected_ids": list(self.expected_ids),
            "found_ids": list(self.found_ids),
            "missing_ids": list(self.missing_ids),
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "source": self.source,
            "message": self.message,
        }
