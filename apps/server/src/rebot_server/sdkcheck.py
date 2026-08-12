"""motorbridge SDK version gate — fail closed.

This server is verified against exactly ONE motorbridge release: **0.5.1**.
Both the read-only scan surface and the telemetry analysis were audited
against the 0.4.9 sdist source (``src/motorbridge/core.py``,
``cli/scan.py`` and the packaged README) and re-verified for 0.5.1 by a
byte-for-byte sdist diff (Phase 7B): the Python binding layer
(``core.py``, ``models.py``, ``__init__.py``, ``abi.py``,
``cli/scan.py``, ``tests/test_api_surface.py``) is unchanged between
0.4.9 and 0.5.1; the only code delta is the CLI motion-run register
(``cli/run.py`` 0x7017 -> 0x7024) — a parameter write this service never
makes. Any other installed version — or an unimportable SDK — is rejected:

* at server startup when ``REBOT_ADAPTER=motorbridge`` (see ``app.py``);
* again inside every scan (see ``scanners/motorbridge.py``) as defense in
  depth.

Simulation mode never imports motorbridge at all.

Version-gate-relevant surface (identical in audited 0.4.9 and pinned 0.5.1):

* ``__version__`` / ``get_version()`` — the version gate below.
* ``abi_version()`` — loads the bundled native library and reports its
  version; used for ``GET /api/health``. Loading it is part of the startup
  gate: if the native library cannot load, no scan could ever succeed.
  (The native ``motor_abi`` library itself changes between releases and is
  not part of the sdist; the gate plus the read-only call surface is the
  mitigation.)
* ``Motor.get_state()`` / ``request_feedback()`` /
  ``Controller.poll_feedback_once()`` — the vendor's recommended read-only
  state flow. Audited for RobStride telemetry: ``request_feedback()`` is a
  documented non-blocking no-op for RobStride motors, so this flow yields no
  data unless active reporting is enabled — which is the single narrowly
  authorized write (``robstride_set_active_report``). See ``telemetry.py``.
"""

from __future__ import annotations

import importlib
from types import ModuleType

from .config import ConfigError

#: The only motorbridge version this server is verified against.
REQUIRED_MOTORBRIDGE_VERSION = "0.5.1"

_MESSAGE_LIMIT = 300


def _sanitize(message: object) -> str:
    """Collapse whitespace and truncate — keeps error messages clean."""
    return " ".join(str(message).split())[:_MESSAGE_LIMIT]


def import_verified_sdk(module_name: str = "motorbridge") -> ModuleType:
    """Import the SDK and verify it is exactly the verified version.

    Raises :class:`ConfigError` (fail closed) when the SDK is missing,
    broken, or a different version. There is no fallback and no
    "close enough" handling: an unverified SDK version might change call
    semantics in ways that invalidate the read-only audit.
    """
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:
        raise ConfigError(
            f"motorbridge SDK unavailable: {type(exc).__name__}: "
            f"{_sanitize(exc)} (fail closed)"
        ) from None
    version = getattr(module, "__version__", None)
    if version != REQUIRED_MOTORBRIDGE_VERSION:
        raise ConfigError(
            f"unsupported motorbridge version {version!r}: this server is "
            f"verified against motorbridge {REQUIRED_MOTORBRIDGE_VERSION} "
            "only (fail closed)"
        )
    return module


def read_abi_version(module: ModuleType) -> str:
    """Return the native ABI version reported by a verified SDK module.

    ``abi_version()`` loads the bundled native library; if that fails the
    SDK installation is broken and no scan could ever succeed — fail closed.
    """
    fn = getattr(module, "abi_version", None)
    if not callable(fn):
        raise ConfigError(
            "motorbridge SDK incompatible: package-level abi_version() not "
            "found; expected motorbridge 0.5.1 (fail closed)"
        )
    try:
        value = fn()
    except Exception as exc:
        raise ConfigError(
            f"motorbridge native ABI unavailable: {type(exc).__name__}: "
            f"{_sanitize(exc)} (fail closed)"
        ) from None
    text = str(value).strip()
    if not text:
        raise ConfigError(
            "motorbridge native ABI reported an empty version (fail closed)"
        )
    return text
