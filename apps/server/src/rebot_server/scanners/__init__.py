"""Adapter factory: choose the scan backend from settings (dependency
injection seam — tests pass their own scanner instances instead)."""

from __future__ import annotations

from ..config import ADAPTER_MOTORBRIDGE, ADAPTER_SIMULATION, ConfigError, Settings
from .base import CanScanner
from .motorbridge import MotorbridgeCanScanner
from .simulation import SimulationCanScanner

__all__ = [
    "CanScanner",
    "MotorbridgeCanScanner",
    "SimulationCanScanner",
    "create_scanner",
]


def create_scanner(settings: Settings) -> CanScanner:
    """Build the scanner selected by ``settings.adapter`` (fail closed)."""
    if settings.adapter == ADAPTER_SIMULATION:
        return SimulationCanScanner(
            found_ids=settings.sim_found_ids,
            scan_delay_s=settings.sim_scan_delay_s,
            fatal_error=settings.sim_fatal_error,
        )
    if settings.adapter == ADAPTER_MOTORBRIDGE:
        return MotorbridgeCanScanner(
            host_id=settings.host_id,
            ping_timeout_ms=settings.ping_timeout_ms,
            persist=True,
            allow_active_report=settings.allow_active_report_write,
            mit_kp=settings.mit_kp,
            mit_kd=settings.mit_kd,
        )
    raise ConfigError(f"unsupported adapter {settings.adapter!r} (fail closed)")
