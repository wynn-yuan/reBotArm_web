"""Shared pytest fixtures for the rebot_server suite."""

import asyncio

import pytest


@pytest.fixture(autouse=True)
def _restore_current_event_loop():
    """Keep a live event loop for the main thread on every test.

    Python 3.8's ``asyncio.run()`` ends by calling ``set_event_loop(None)``
    and closing the loop (tests in test_activereport.py / test_telemetry.py
    rely on it). Any later ``asyncio.Lock()`` — e.g. in
    ``MotorbridgeTelemetryHub.__init__`` — then raises "no current event
    loop". Restoring a fresh loop per test makes the suite order-independent.
    """
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop