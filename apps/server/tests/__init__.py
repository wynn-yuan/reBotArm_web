"""Test package for rebot_server.

Makes ``src/`` importable without installing the package, so the suite can
run with plain ``python -m unittest discover -s tests`` as well as pytest.

Rules for this suite:
  * stdlib ``unittest`` first; no test may require CAN hardware.
  * Tests needing FastAPI/httpx skip automatically when those are absent.
"""

from __future__ import annotations

import os
import sys

_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"
)
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)
