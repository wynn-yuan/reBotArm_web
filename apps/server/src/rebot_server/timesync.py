"""Startup network time sync (HTTP ``Date`` header) and offset accessors.

The Jetson may only have internet briefly at boot (or not at all) while the
local RTC can drift for months. Setting the system clock requires root, which
this user-space service does not have, so on every startup we sample an HTTP
server's ``Date`` header and keep the measured offset in a module global. All
aging-session wall-clock timestamps are corrected by that offset, so logs stay
accurate even when the operating-system clock is wrong or the boot went offline
(offset then stays 0.0 and the failure is logged).

Pure stdlib by design — no ntplib/chrony dependency, and it works behind
proxies that block NTP but allow HTTPS.
"""

from __future__ import annotations

import datetime as _dt
import logging
import math
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime

logger = logging.getLogger(__name__)

#: Process-lifetime correction in seconds: (network UTC) - (local UTC).
CLOCK_OFFSET_SECONDS = 0.0

#: Hosts probed in order; the first successful (sane) response wins.
DEFAULT_TIMESYNC_HOSTS = ("https://api.github.com",)
#: Per-host probe timeout — keeps the whole sync well inside the startup
#: budget while the health check allows 15 s.
SYNC_TIMEOUT_S = 2.0
#: Garbage filter only — a months-drifting RTC is exactly what this corrects,
#: so the bound is deliberately loose (366 days).
SANE_MAX_ABS_OFFSET_S = 366 * 24 * 3600


def parse_http_date(raw: str | None) -> _dt.datetime | None:
    """Parse an HTTP ``Date`` header into an aware UTC datetime, or None."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if parsed.tzinfo is None:
        # parsedate_to_datetime may return naive; timestamp() would then use
        # the local zone, so normalize to UTC explicitly.
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.astimezone(_dt.timezone.utc)


def sane_offset(offset: float) -> bool:
    """Whether an offset is finite and inside the sanity bound."""
    return math.isfinite(offset) and abs(offset) <= SANE_MAX_ABS_OFFSET_S


def clock_now() -> _dt.datetime:
    """Offset-corrected current UTC time."""
    return _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(
        seconds=CLOCK_OFFSET_SECONDS
    )


def clock_now_iso() -> str:
    """Offset-corrected current UTC time as an ISO-8601 string."""
    return clock_now().isoformat()


def _probe_host(
    host: str, *, timeout: float
) -> tuple[_dt.datetime | None, str | None]:
    """Return ``(network_time, source)`` from ``host``.

    Reads ``Date`` from both 2xx responses and HTTP errors — an API quota 403
    still carries a valid Date header and is perfectly good for time sync.
    """
    req = urllib.request.Request(host, headers={"User-Agent": "rebot-server-timesync"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            headers = resp.headers
    except urllib.error.HTTPError as exc:
        headers = exc.headers
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return None, f"{type(exc).__name__}: {exc}"
    if headers is None:
        return None, "no headers returned"
    net = parse_http_date(headers.get("Date"))
    if net is None:
        return None, "missing or invalid Date header"
    return net, host


def sync_device_clock_once(
    *, timeout_per_host: float = SYNC_TIMEOUT_S, hosts=DEFAULT_TIMESYNC_HOSTS
) -> bool:
    """Probe hosts, measure the clock offset, and update the module global.

    Returns True when a sane offset was captured. Never raises on network
    errors and never fails the boot when offline — the offset just stays 0.0
    and a warning is logged.
    """
    global CLOCK_OFFSET_SECONDS
    last_error = "no hosts configured"
    for host in hosts:
        net, err = _probe_host(host, timeout=timeout_per_host)
        if net is None:
            last_error = err or "probe failed"
            continue
        local = _dt.datetime.now(_dt.timezone.utc)
        offset = (net - local).total_seconds()
        if not sane_offset(offset):
            last_error = f"unsane offset {offset:.1f}s from {host}"
            continue
        CLOCK_OFFSET_SECONDS = offset
        logger.info(
            "time sync ok",
            extra={
                "type": "time_sync",
                "result": "ok",
                "source": host,
                "net_utc": net.isoformat(),
                "local_utc": local.isoformat(),
                "offset_seconds": round(offset, 3),
            },
        )
        return True
    logger.warning(
        "time sync unavailable; using local clock offline",
        extra={
            "type": "time_sync",
            "result": "unavailable",
            "error": last_error,
            "offset_seconds": 0.0,
        },
    )
    return False