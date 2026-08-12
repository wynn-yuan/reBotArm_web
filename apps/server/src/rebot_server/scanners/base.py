"""Adapter interface for CAN scan backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Sequence

from ..models import ScanOutcome


class CanScanner(ABC):
    """A backend that can tell which motor IDs respond on a CAN channel.

    Contract:
      * Implementations must not raise for per-motor problems — report them
        via the returned :class:`ScanOutcome`. Only truly unexpected
        situations may raise; the service layer catches those and maps them
        to status ``error``.
      * Probing must happen serially (one ID after another) so a single CAN
        controller is never used concurrently.
      * Phase 1 is strictly read-only: implementations must never emit
        control frames (enable/disable, motion, parameter writes).
    """

    #: Stable backend name, reported as ``source`` in the API.
    source: str = "unknown"

    @abstractmethod
    def scan(self, channel: str, expected_ids: Sequence[int]) -> ScanOutcome:
        """Probe *expected_ids* on *channel* serially and return the outcome."""

    def release(self) -> None:
        """Best-effort release of held resources.

        Must never emit control frames. Default: nothing held.
        """
