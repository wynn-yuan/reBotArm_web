"""Development adapter: simulates CAN scan results without touching CAN."""

from __future__ import annotations

import time
from typing import Optional, Sequence

from ..config import ConfigError, validate_channel
from ..models import EXPECTED_MOTOR_IDS, ScanOutcome
from .base import CanScanner


class SimulationCanScanner(CanScanner):
    """Default adapter for development. Never accesses CAN hardware.

    Which IDs "respond" is controlled by the constructor (typically wired
    from the ``REBOT_SIM_FOUND_IDS`` environment variable) and defaults to
    all expected IDs 1..7, i.e. a simulated ``connected``.
    """

    source = "simulation"

    def __init__(
        self,
        found_ids: Optional[Sequence[int]] = None,
        scan_delay_s: float = 0.0,
        fatal_error: bool = False,
    ) -> None:
        if found_ids is None:
            found_ids = EXPECTED_MOTOR_IDS
        self._found_ids = tuple(sorted(set(found_ids)))
        self._scan_delay_s = max(0.0, float(scan_delay_s))
        self._fatal_error = bool(fatal_error)

    def scan(self, channel: str, expected_ids: Sequence[int]) -> ScanOutcome:
        try:
            validate_channel(channel)
        except ConfigError as exc:
            # Defense in depth: the service already validates the channel.
            return ScanOutcome(fatal_message=f"invalid channel: {exc}")
        if self._fatal_error:
            return ScanOutcome(
                fatal_message="simulated adapter failure (REBOT_SIM_FATAL_ERROR=1)"
            )
        if self._scan_delay_s:
            time.sleep(self._scan_delay_s)
        expected = set(expected_ids)
        found = tuple(
            sorted(motor_id for motor_id in self._found_ids if motor_id in expected)
        )
        return ScanOutcome(found_ids=found)
