"""Phase 5 tests: RobStride active-report telemetry — the ONLY authorized
motor write (``robstride_set_active_report`` True/False).

Coverage per Phase 5 requirement 14:

1.  default configuration never calls ``robstride_set_active_report``;
2.  under explicit authorization, IDs 1..7 each receive ``True`` exactly
    once (and real state is streamed via poll_feedback_once -> get_state);
3.  last-client disconnect calls ``False`` exactly once per enabled motor,
    followed by the audited read-only release;
4.  partial enable failure rolls back successfully enabled motors
    (``False``) and releases all handles; incomplete data never streams;
5.  repeat/long-lived subscription does not re-enable;
6.  multiple clients: the session only stops when the LAST one leaves;
7.  service-generation invalidation (disconnect) stops the stream and
    performs the authorized cleanup;
8.  no write calls other than the active-report toggle ever reach the SDK
    (``request_feedback`` — documented no-op for RobStride — included);
9.  frame fields and units match the 0.5.1 contract
    (rad / rad/s / Nm / degC); unsupported fields stay null;
10. slow clients keep only the newest frame (bounded keep-latest queue).

No hardware is touched and no real CAN is connected: a recording fake
shaped like the motorbridge 0.5.1 API is injected into ``sys.modules``.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
import types
import unittest
from unittest import mock

from rebot_server import activereport as activereport_module
from rebot_server.activereport import (
    ActiveReportSession,
    MotorbridgeTelemetryHub,
    SharedActiveReportSession,
    TELEMETRY_READ_FAILURE_THRESHOLD,
    TelemetryReadFailure,
    TelemetrySessionError,
)
from rebot_server.config import ADAPTER_MOTORBRIDGE, Settings
from rebot_server.models import EXPECTED_MOTOR_IDS, STATUS_CONNECTED
from rebot_server.scanners.motorbridge import (
    ACTIVE_REPORT_AUTHORIZED_CALL,
    FORBIDDEN_SDK_CALLS,
)
from rebot_server.service import BusBusyError, ScanInProgressError
from rebot_server.sdkcheck import REQUIRED_MOTORBRIDGE_VERSION
from rebot_server.telemetry import UNITS

try:
    import httpx  # noqa: F401  (required by TestClient)
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from rebot_server.app import create_app

    _DEPS_AVAILABLE = True
except Exception:  # ImportError or broken install
    _DEPS_AVAILABLE = False


# ---------------------------------------------------------------------------
# Fake SDK shaped like motorbridge 0.5.1 (recording + steering)
# ---------------------------------------------------------------------------


class FakeArSdk:
    """Shared recording / steering state for the fake SDK classes."""

    calls = []               # (scope, name, args, kwargs); scope: ctrl|motor
    enable_errors = {}       # motor_id -> exception on set_active_report(True)
    disable_errors = {}      # motor_id -> exception on set_active_report(False)
    add_errors = {}          # motor_id -> exception on add_robstride_motor
    ping_errors = {}         # motor_id -> exception on robstride_ping_host_id
    controller_error = None  # raised by Controller.__init__
    poll_error = None        # raised by Controller.poll_feedback_once
    poll_block_event = None  # if set, poll_feedback_once blocks on it (timeout test)
    states = {}              # motor_id -> MotorState-shaped object (or absent)
    get_state_errors = {}    # motor_id -> exception on get_state

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.enable_errors = {}
        cls.disable_errors = {}
        cls.add_errors = {}
        cls.ping_errors = {}
        cls.controller_error = None
        cls.poll_error = None
        cls.poll_block_event = None
        cls.states = {}
        cls.get_state_errors = {}

    @classmethod
    def motor_calls(cls, name):
        return [c for c in cls.calls if c[0] == "motor" and c[1] == name]

    @classmethod
    def ctrl_calls(cls, name):
        return [c for c in cls.calls if c[0] == "ctrl" and c[1] == name]

    @classmethod
    def motor_method_names(cls):
        return {c[1] for c in cls.calls if c[0] == "motor"}

    @classmethod
    def ctrl_method_names(cls):
        return {c[1] for c in cls.calls if c[0] == "ctrl"}

    @classmethod
    def active_report_calls(cls):
        """Ordered (motor_id, enabled) pairs of every authorized write."""
        return [c[2] for c in cls.motor_calls("robstride_set_active_report")]


class FakeArMotor:
    """Motor handle with the real 0.5.1 surface used by scan + telemetry."""

    def __init__(self, motor_id, feedback_id, model):
        self.motor_id = motor_id
        self.feedback_id = feedback_id
        self.model = model

    def robstride_ping_host_id(self, host_id, timeout_ms=500):
        FakeArSdk.calls.append(
            ("motor", "robstride_ping_host_id", (self.motor_id, host_id, timeout_ms), {})
        )
        exc = FakeArSdk.ping_errors.get(self.motor_id)
        if exc is not None:
            raise exc
        return (self.motor_id, self.feedback_id)

    def robstride_set_active_report(self, enabled):
        # The real signature: a single boolean (core.py of 0.5.1).
        FakeArSdk.calls.append(
            ("motor", "robstride_set_active_report", (self.motor_id, bool(enabled)), {})
        )
        exc = (
            FakeArSdk.enable_errors.get(self.motor_id)
            if enabled
            else FakeArSdk.disable_errors.get(self.motor_id)
        )
        if exc is not None:
            raise exc

    def get_state(self):
        FakeArSdk.calls.append(("motor", "get_state", (self.motor_id,), {}))
        exc = FakeArSdk.get_state_errors.get(self.motor_id)
        if exc is not None:
            raise exc
        return FakeArSdk.states.get(self.motor_id)

    def close(self):
        FakeArSdk.calls.append(("motor", "close", (self.motor_id,), {}))

    def __getattr__(self, name):
        # Tamper trap: any other motor call (enable/disable/send_*/param
        # writes/request_feedback/...) is recorded and fails loudly.
        def _trap(*args, **kwargs):
            FakeArSdk.calls.append(("motor", name, args, kwargs))
            raise AssertionError(f"unexpected motor SDK call: {name}")

        return _trap


class FakeArController:
    """Controller with the real 0.5.1 signature: ``Controller(channel)``."""

    def __init__(self, channel):
        FakeArSdk.calls.append(("ctrl", "__init__", (channel,), {}))
        self.channel = channel
        if FakeArSdk.controller_error is not None:
            raise FakeArSdk.controller_error

    def add_robstride_motor(self, motor_id, feedback_id, model):
        FakeArSdk.calls.append(
            ("ctrl", "add_robstride_motor", (motor_id, feedback_id, model), {})
        )
        exc = FakeArSdk.add_errors.get(motor_id)
        if exc is not None:
            raise exc
        return FakeArMotor(motor_id, feedback_id, model)

    def poll_feedback_once(self):
        FakeArSdk.calls.append(("ctrl", "poll_feedback_once", (), {}))
        if FakeArSdk.poll_block_event is not None:
            # Simulate a stuck native call: block until the test releases us.
            FakeArSdk.poll_block_event.wait(timeout=10)
        if FakeArSdk.poll_error is not None:
            raise FakeArSdk.poll_error

    def close_bus(self):
        FakeArSdk.calls.append(("ctrl", "close_bus", (), {}))

    def close(self):
        FakeArSdk.calls.append(("ctrl", "close", (), {}))

    def __getattr__(self, name):
        # Tamper trap for controller-level control calls.
        def _trap(*args, **kwargs):
            FakeArSdk.calls.append(("ctrl", name, args, kwargs))
            raise AssertionError(f"unexpected controller SDK call: {name}")

        return _trap


def _state(pos=0.0, vel=0.0, torq=0.0, t_mos=30.0, t_rotor=27.0, status_code=0):
    """MotorState-shaped object (0.5.1 models.py field names)."""
    return types.SimpleNamespace(
        pos=pos, vel=vel, torq=torq, t_mos=t_mos, t_rotor=t_rotor,
        status_code=status_code,
    )


class _FakeSdkGuard(unittest.TestCase):
    """Install the fake SDK and restore sys.modules around every test."""

    def setUp(self):
        FakeArSdk.reset()
        self._saved = sys.modules.get("motorbridge", "MISSING")
        self._install_fake_sdk()

    def tearDown(self):
        if self._saved == "MISSING":
            sys.modules.pop("motorbridge", None)
        else:
            sys.modules["motorbridge"] = self._saved

    def _install_fake_sdk(self, version=REQUIRED_MOTORBRIDGE_VERSION):
        module = types.ModuleType("motorbridge")
        module.__version__ = version
        module.get_version = lambda: version
        module.abi_version = lambda: "fake-abi-0.5.1"
        module.Controller = FakeArController
        sys.modules["motorbridge"] = module

    def _eventually(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return predicate()


# ---------------------------------------------------------------------------
# Session-level unit tests (stdlib only, no FastAPI)
# ---------------------------------------------------------------------------


class ActiveReportSessionUnitTests(_FakeSdkGuard):
    def test_start_enable_poll_stop_disable_release_ordering(self):
        for mid in EXPECTED_MOTOR_IDS:
            FakeArSdk.states[mid] = _state(pos=mid * 0.1, vel=0.2, torq=-0.3)
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        session.start()
        try:
            # The authorized write: True exactly once per ID, in ID order.
            self.assertEqual(
                FakeArSdk.active_report_calls(),
                [(mid, True) for mid in EXPECTED_MOTOR_IDS],
            )
            time.sleep(0.05)  # let the background poll thread run
            self.assertGreaterEqual(
                len(FakeArSdk.ctrl_calls("poll_feedback_once")),
                1,
                "official post-enable flow poll_feedback_once -> get_state",
            )
            frame = session.build_frame(1)
        finally:
            session.stop()

        # Frame contract with the real state values + explicit units.
        self.assertEqual(frame["source"], "motorbridge")
        self.assertEqual(frame["channel"], "can0")
        self.assertEqual(frame["sequence"], 1)
        self.assertTrue(frame["timestamp"])
        self.assertEqual(frame["units"], UNITS)
        joints = {j["id"]: j for j in frame["joints"]}
        self.assertEqual(set(joints), set(EXPECTED_MOTOR_IDS))
        self.assertAlmostEqual(joints[3]["position"], 0.3)
        self.assertEqual(joints[3]["velocity"], 0.2)
        self.assertEqual(joints[3]["torque"], -0.3)
        self.assertEqual(joints[3]["freshness"], "fresh")
        self.assertIsNone(joints[3]["current"])
        self.assertIsNone(joints[3]["error_code"])

        # Cleanup: False exactly once per enabled motor, then audited
        # read-only release (7 closes, close_bus, controller close).
        self.assertEqual(
            FakeArSdk.active_report_calls(),
            [(mid, True) for mid in EXPECTED_MOTOR_IDS]
            + [(mid, False) for mid in EXPECTED_MOTOR_IDS],
        )
        self.assertEqual(len(FakeArSdk.motor_calls("close")), 7)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close")), 1)
        # request_feedback is a documented no-op for RobStride: never called.
        self.assertEqual(FakeArSdk.motor_calls("request_feedback"), [])
        # No forbidden call ever reached the SDK.
        self.assertEqual(
            (FakeArSdk.motor_method_names() | FakeArSdk.ctrl_method_names())
            & FORBIDDEN_SDK_CALLS,
            set(),
        )

    def test_partial_enable_failure_rolls_back_and_releases(self):
        FakeArSdk.enable_errors[3] = RuntimeError("motor 3 refused")
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        with self.assertRaises(TelemetrySessionError) as ctx:
            session.start()
        self.assertIn("rolled back", str(ctx.exception))
        # Motors 1-2 enabled then rolled back; 3 failed its enable; 4-7
        # never written to.
        self.assertEqual(
            FakeArSdk.active_report_calls(),
            [(1, True), (2, True), (3, True), (1, False), (2, False)],
        )
        # ALL 7 handles were created before the enable loop, so the
        # read-only release closes all 7 (not just the enabled ones); the
        # poll thread never started.
        self.assertEqual(len(FakeArSdk.motor_calls("close")), 7)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close")), 1)
        self.assertEqual(FakeArSdk.ctrl_calls("poll_feedback_once"), [])

    def test_stop_disable_failure_is_logged_not_fatal(self):
        # Communication may be gone at cleanup time: a failed disable must
        # not prevent the remaining disables or the read-only release, and
        # no OTHER control method may be attempted instead.
        FakeArSdk.disable_errors[2] = OSError("bus gone")
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        session.start()
        session.stop()
        disables = [c for c in FakeArSdk.active_report_calls() if not c[1]]
        self.assertEqual(disables, [(mid, False) for mid in EXPECTED_MOTOR_IDS])
        self.assertEqual(len(FakeArSdk.motor_calls("close")), 7)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close")), 1)

    def test_wrong_version_module_refused_before_any_call(self):
        module = types.ModuleType("motorbridge")
        module.__version__ = "0.4.8"
        module.Controller = FakeArController
        session = ActiveReportSession(module, "can0", 0xFD, EXPECTED_MOTOR_IDS)
        with self.assertRaises(TelemetrySessionError):
            session.start()
        self.assertEqual(FakeArSdk.calls, [])

    def test_missing_state_is_reported_null_not_fabricated(self):
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        session.start()
        try:
            frame = session.build_frame(1)
        finally:
            session.stop()
        for joint in frame["joints"]:
            self.assertIsNone(joint["position"])
            self.assertIsNone(joint["status_code"])
            self.assertEqual(joint["freshness"], "none")

    def test_get_state_failure_reports_null_for_that_motor(self):
        FakeArSdk.states[1] = _state(pos=1.0)
        FakeArSdk.get_state_errors[2] = RuntimeError("native error")
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, (1, 2)
        )
        session.start()
        try:
            frame = session.build_frame(1)
        finally:
            session.stop()
        joints = {j["id"]: j for j in frame["joints"]}
        self.assertEqual(joints[1]["position"], 1.0)
        self.assertIsNone(joints[2]["position"])
        self.assertEqual(joints[2]["freshness"], "none")


# ---------------------------------------------------------------------------
# Phase 7A: stop() must confirm the poll thread exited before releasing
# ---------------------------------------------------------------------------


class ActiveReportSessionStopSemanticsTests(_FakeSdkGuard):
    """stop() ordering + fail-closed teardown (thread death confirmed first)."""

    def _release_sequence(self):
        """Ordered cleanup-relevant calls: disables, motor closes, bus/ctrl close."""
        seq = []
        for scope, name, args, _ in FakeArSdk.calls:
            if name == "robstride_set_active_report" and args and args[1] is False:
                seq.append(("disable", args[0]))
            elif scope == "motor" and name == "close":
                seq.append(("motor_close", args[0]))
            elif scope == "ctrl" and name == "close_bus":
                seq.append(("close_bus", None))
            elif scope == "ctrl" and name == "close":
                seq.append(("ctrl_close", None))
        return seq

    def test_normal_stop_releases_in_order(self):
        for mid in EXPECTED_MOTOR_IDS:
            FakeArSdk.states[mid] = _state(pos=mid * 0.1)
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        session.start()
        time.sleep(0.05)  # let the poll thread run at least once
        self.assertTrue(session.stop())

        seq = self._release_sequence()
        disables = [i for i, s in enumerate(seq) if s[0] == "disable"]
        motor_closes = [i for i, s in enumerate(seq) if s[0] == "motor_close"]
        close_bus = [i for i, s in enumerate(seq) if s[0] == "close_bus"]
        ctrl_close = [i for i, s in enumerate(seq) if s[0] == "ctrl_close"]
        # Ordering: every disable -> every motor close -> close_bus -> ctrl close.
        self.assertEqual(len(disables), len(EXPECTED_MOTOR_IDS))
        self.assertEqual(len(motor_closes), len(EXPECTED_MOTOR_IDS))
        self.assertEqual(len(close_bus), 1)
        self.assertEqual(len(ctrl_close), 1)
        self.assertLess(max(disables), min(motor_closes))
        self.assertLess(max(motor_closes), min(close_bus))
        self.assertLess(max(close_bus), min(ctrl_close))

    def test_stop_is_idempotent_and_does_not_double_release(self):
        for mid in EXPECTED_MOTOR_IDS:
            FakeArSdk.states[mid] = _state()
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        session.start()
        self.assertTrue(session.stop())
        closes_after_first = len(FakeArSdk.motor_calls("close"))
        bus_after_first = len(FakeArSdk.ctrl_calls("close_bus"))
        # Repeat stop: still reports success, releases nothing again.
        self.assertTrue(session.stop())
        self.assertTrue(session.stop())
        self.assertEqual(len(FakeArSdk.motor_calls("close")), closes_after_first)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), bus_after_first)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close")), 1)

    def test_stop_fails_closed_when_poll_thread_blocked(self):
        block = threading.Event()
        FakeArSdk.poll_block_event = block
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        session.start()
        # Wait until the poll thread is inside (blocked in) poll_feedback_once.
        self.assertTrue(
            self._eventually(lambda: FakeArSdk.ctrl_calls("poll_feedback_once"))
        )
        with mock.patch.object(activereport_module, "_POLL_JOIN_TIMEOUT_S", 0.05):
            self.assertFalse(session.stop())
        # Fail closed: NO disables and NO releases while the thread is unconfirmed.
        self.assertEqual(
            [c for c in FakeArSdk.active_report_calls() if not c[1]], []
        )
        self.assertEqual(FakeArSdk.motor_calls("close"), [])
        self.assertEqual(FakeArSdk.ctrl_calls("close_bus"), [])
        self.assertEqual(FakeArSdk.ctrl_calls("close"), [])
        # Even after the thread is finally released and exits, stop stays
        # fail-closed: resources are intentionally never released (restart-only).
        block.set()
        time.sleep(0.1)  # allow the (daemon) poll thread to drain out
        self.assertFalse(session.stop())
        self.assertEqual(FakeArSdk.motor_calls("close"), [])
        self.assertEqual(FakeArSdk.ctrl_calls("close_bus"), [])
        self.assertEqual(FakeArSdk.ctrl_calls("close"), [])

    def test_stop_after_failed_start_releases_nothing_extra(self):
        # A failed start() already rolled back and released; a later stop()
        # must be safe and must not release anything a second time.
        FakeArSdk.enable_errors[3] = RuntimeError("motor 3 refused")
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        with self.assertRaises(TelemetrySessionError):
            session.start()
        closes = len(FakeArSdk.motor_calls("close"))
        bus = len(FakeArSdk.ctrl_calls("close_bus"))
        ctrl = len(FakeArSdk.ctrl_calls("close"))
        self.assertTrue(session.stop())
        self.assertEqual(len(FakeArSdk.motor_calls("close")), closes)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), bus)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close")), ctrl)

    def test_stop_without_start_is_safe(self):
        session = ActiveReportSession(
            sys.modules["motorbridge"], "can0", 0xFD, EXPECTED_MOTOR_IDS
        )
        # Never started: no thread, no handles. stop() is a safe no-op.
        self.assertTrue(session.stop())
        self.assertEqual(FakeArSdk.calls, [])


# ---------------------------------------------------------------------------
# Authorization gates (TestClient)
# ---------------------------------------------------------------------------


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class ActiveReportGateTests(_FakeSdkGuard):
    """Without ALL gate conditions, no motor is ever written to."""

    def _mb_app(self, **overrides):
        overrides.setdefault("adapter", ADAPTER_MOTORBRIDGE)
        overrides.setdefault("telemetry_hz", 50.0)
        return create_app(settings=Settings(**overrides))

    def _scan_connected(self, client):
        body = client.post("/api/robot/scan").json()
        self.assertEqual(body["status"], "connected", body)
        # Drop the scan's SDK calls so later assertions see only the
        # telemetry-session lifecycle.
        FakeArSdk.calls.clear()

    def test_default_config_never_calls_active_report(self):
        # Requirement: REBOT_ALLOW_ACTIVE_REPORT_WRITE defaults to 0.
        app = self._mb_app(allow_active_report_write=False)
        with TestClient(app) as client:
            self._scan_connected(client)
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                error = ws.receive_json()
                self.assertEqual(
                    error["error"]["code"], "telemetry_not_allowed"
                )
                self.assertIn(
                    "REBOT_ALLOW_ACTIVE_REPORT_WRITE",
                    error["error"]["message"],
                )
                self.assertNotIn("Traceback", error["error"]["message"])
                with self.assertRaises(WebSocketDisconnect):
                    ws.receive_json()
        self.assertEqual(
            FakeArSdk.motor_calls("robstride_set_active_report"), []
        )
        self.assertEqual(
            (FakeArSdk.motor_method_names() | FakeArSdk.ctrl_method_names())
            & FORBIDDEN_SDK_CALLS,
            set(),
        )

    def test_flag_on_but_no_connected_scan_rejects_without_writes(self):
        app = self._mb_app(allow_active_report_write=True)
        with TestClient(app) as client:
            # No scan performed -> status disconnected.
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                error = ws.receive_json()
                self.assertEqual(
                    error["error"]["code"], "telemetry_requires_connected"
                )
                with self.assertRaises(WebSocketDisconnect):
                    ws.receive_json()
        self.assertEqual(
            FakeArSdk.motor_calls("robstride_set_active_report"), []
        )

    def test_partial_scan_does_not_authorize_enabling(self):
        FakeArSdk.ping_errors = {4: TimeoutError("no reply from 4")}
        app = self._mb_app(allow_active_report_write=True)
        with TestClient(app) as client:
            body = client.post("/api/robot/scan").json()
            self.assertEqual(body["status"], "partial")
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                error = ws.receive_json()
                self.assertEqual(
                    error["error"]["code"], "telemetry_requires_connected"
                )
        self.assertEqual(
            FakeArSdk.motor_calls("robstride_set_active_report"), []
        )

    def test_wrong_sdk_version_at_session_start_fails_closed(self):
        # Phase 7I keeps the verified Controller from scan time; telemetry
        # does not open or re-verify a second Controller.
        app = self._mb_app(allow_active_report_write=True)
        with TestClient(app) as client:
            self._scan_connected(client)
            self._install_fake_sdk(version="0.4.8")  # swapped after startup
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                frame = ws.receive_json()
                self.assertEqual(frame["source"], "motorbridge")
        self.assertEqual(
            FakeArSdk.active_report_calls(),
            [(mid, False) for mid in EXPECTED_MOTOR_IDS],
        )

    def test_sdk_missing_at_session_start_fails_closed(self):
        app = self._mb_app(allow_active_report_write=True)
        with TestClient(app) as client:
            self._scan_connected(client)
            sys.modules["motorbridge"] = None  # unimportable
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                frame = ws.receive_json()
                self.assertEqual(frame["source"], "motorbridge")
        self.assertEqual(
            FakeArSdk.active_report_calls(),
            [(mid, False) for mid in EXPECTED_MOTOR_IDS],
        )


# ---------------------------------------------------------------------------
# Phase 7A: /api/health capabilities contract (motorbridge adapter)
# ---------------------------------------------------------------------------


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class HealthCapabilitiesContractTests(_FakeSdkGuard):
    """capabilities under the real-adapter path: the active-report write and
    the telemetry capability are true only when explicitly authorized."""

    def _mb_app(self, **overrides):
        overrides.setdefault("adapter", ADAPTER_MOTORBRIDGE)
        return create_app(settings=Settings(**overrides))

    def test_health_capabilities_flag_off(self):
        app = self._mb_app(allow_active_report_write=False)
        with TestClient(app) as client:
            body = client.get("/api/health").json()
        caps = body["capabilities"]
        self.assertFalse(caps["telemetry"])
        self.assertFalse(caps["active_report_write"])
        self.assertTrue(caps["scan"])
        self.assertFalse(caps["control"])
        # The verified 0.5.1 SDK is present (fake) so versions are populated.
        self.assertEqual(body["motorbridge_version"], REQUIRED_MOTORBRIDGE_VERSION)

    def test_health_capabilities_flag_on(self):
        app = self._mb_app(allow_active_report_write=True)
        with TestClient(app) as client:
            caps = client.get("/api/health").json()["capabilities"]
        self.assertTrue(caps["telemetry"])
        self.assertTrue(caps["active_report_write"])
        self.assertTrue(caps["scan"])
        self.assertFalse(caps["control"])
        self.assertFalse(caps["homing"])
        self.assertFalse(caps["disable"])
        self.assertFalse(caps["parameter_write"])


# ---------------------------------------------------------------------------
# Full lifecycle through the WebSocket endpoint (TestClient)
# ---------------------------------------------------------------------------


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class ActiveReportLifecycleTests(_FakeSdkGuard):
    def _mb_app(self, **overrides):
        overrides.setdefault("adapter", ADAPTER_MOTORBRIDGE)
        overrides.setdefault("allow_active_report_write", True)
        overrides.setdefault("telemetry_hz", 50.0)
        return create_app(settings=Settings(**overrides))

    def _scan_connected(self, client):
        body = client.post("/api/robot/scan").json()
        self.assertEqual(body["status"], "connected", body)
        FakeArSdk.calls.clear()

    def test_authorized_enables_once_per_motor_and_streams_real_state(self):
        for mid in EXPECTED_MOTOR_IDS:
            FakeArSdk.states[mid] = _state(
                pos=mid * 0.5, vel=0.1 * mid, torq=-0.2, t_mos=31.0 + mid
            )
        app = self._mb_app()
        expected_full = []
        with TestClient(app) as client:
            self._scan_connected(client)
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                frames = [ws.receive_json() for _ in range(2)]
                # Active reporting was configured during scan. The websocket
                # only receives/parses feedback and emits no write.
                self.assertEqual(FakeArSdk.active_report_calls(), [])
            # After the (last) client disconnected: False exactly once per
            # motor, in order, followed by the audited read-only release.
            # (Awaited: test clients may cancel the connection task, so the
            # shielded cleanup completes asynchronously.)
            self.assertTrue(
                self._eventually(
                    lambda: FakeArSdk.active_report_calls() == expected_full
                ),
                f"got {FakeArSdk.active_report_calls()}",
            )
            # The single Controller remains owned by the connection until
            # explicit disconnect or service shutdown.
            self.assertEqual(FakeArSdk.motor_calls("close"), [])

        # Frame contract: units, source, real values, nulls for unsupported.
        for frame in frames:
            self.assertEqual(frame["source"], "motorbridge")
            self.assertEqual(frame["channel"], "can0")
            self.assertEqual(frame["units"], UNITS)
            self.assertEqual(len(frame["joints"]), 7)
            self.assertTrue(frame["timestamp"])
        joints = {j["id"]: j for j in frames[0]["joints"]}
        for mid in EXPECTED_MOTOR_IDS:
            joint = joints[mid]
            self.assertAlmostEqual(joint["position"], mid * 0.5)
            self.assertAlmostEqual(joint["velocity"], 0.1 * mid)
            self.assertEqual(joint["torque"], -0.2)
            self.assertEqual(joint["freshness"], "fresh")
            self.assertEqual(joint["status_code"], 0)
            self.assertIsNone(joint["current"])
            self.assertIsNone(joint["error_code"])
        self.assertGreater(frames[1]["sequence"], frames[0]["sequence"])

    def test_repeat_subscription_does_not_re_enable(self):
        app = self._mb_app()
        with TestClient(app) as client:
            self._scan_connected(client)
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                for _ in range(3):
                    ws.receive_json()
                enables = [
                    c for c in FakeArSdk.active_report_calls() if c[1]
                ]
                # No active-report write occurs after the scan.
                self.assertEqual(len(enables), 0)
                self.assertEqual(
                    [c for c in FakeArSdk.active_report_calls() if not c[1]],
                    [],
                )
            # Wait out the (async) teardown so no session leaks past this
            # test: exactly one disable per motor, no re-enables.
            self.assertEqual([c for c in FakeArSdk.active_report_calls() if not c[1]], [])
            self.assertEqual(len([c for c in FakeArSdk.active_report_calls() if c[1]]), 0)

    def test_multiple_clients_only_stop_on_last_disconnect(self):
        app = self._mb_app()
        with TestClient(app) as client:
            self._scan_connected(client)
            with client.websocket_connect("/ws/robot/telemetry") as ws_a:
                ws_a.receive_json()
                with client.websocket_connect("/ws/robot/telemetry") as ws_b:
                    ws_b.receive_json()
                    # Shared session: still exactly 7 enables, no duplicate
                    # enabling for the second subscriber.
                self.assertEqual(len([c for c in FakeArSdk.active_report_calls() if c[1]]), 0)
                # ws_b is gone but ws_a remains: no disable yet.
                self.assertEqual(
                    [c for c in FakeArSdk.active_report_calls() if not c[1]],
                    [],
                )
                frame = ws_a.receive_json()  # still streaming
                self.assertGreaterEqual(frame["sequence"], 1)
            # Telemetry client lifetime does not own active-report lifetime;
            # disconnect/service shutdown performs cleanup.
            self.assertEqual([c for c in FakeArSdk.active_report_calls() if not c[1]], [])

    def test_generation_invalidation_stops_session_and_disables(self):
        app = self._mb_app()
        service = app.state.service
        with TestClient(app) as client:
            self._scan_connected(client)
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                ws.receive_json()
                service.disconnect()  # bumps the safety generation
                with self.assertRaises(WebSocketDisconnect):
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        ws.receive_json()
                    raise AssertionError("socket was not closed in time")
            # Stream stopped AND the authorized cleanup ran (False once per
            # motor + audited release).
            self.assertTrue(
                self._eventually(
                    lambda: len(
                        [c for c in FakeArSdk.active_report_calls() if not c[1]]
                    )
                    == 7
                ),
                "expected robstride_set_active_report(False) once per motor",
            )
            self.assertTrue(
                self._eventually(
                    lambda: len(FakeArSdk.motor_calls("close")) == 7
                    and len(FakeArSdk.ctrl_calls("close_bus")) == 1
                    and len(FakeArSdk.ctrl_calls("close")) == 1
                )
            )

    def test_partial_enable_failure_rolls_back_and_allows_retry(self):
        FakeArSdk.enable_errors[5] = RuntimeError("motor 5 refused active-report configuration")
        app = self._mb_app()
        with TestClient(app) as client:
            body = client.post("/api/robot/scan").json()
            self.assertEqual(body["status"], "error")
            # Rollback: 1-4 enabled then disabled; 5 failed its enable.
            self.assertEqual(
                FakeArSdk.active_report_calls(),
                [(1, True), (2, True), (3, True), (4, True), (5, True),
                 (1, False), (2, False), (3, False), (4, False)],
            )
            # All created handles were released despite the failure.
            self.assertEqual(len(FakeArSdk.motor_calls("close")), 7)
            self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), 1)
            self.assertEqual(len(FakeArSdk.ctrl_calls("close")), 1)

            # The failure did not wedge the scanner: after the fault clears a
            # new full scan can configure active reporting again.
            FakeArSdk.enable_errors = {}
            FakeArSdk.calls.clear()
            self.assertEqual(client.post("/api/robot/scan").json()["status"], "connected")
            self.assertEqual(
                FakeArSdk.active_report_calls(),
                [(mid, True) for mid in EXPECTED_MOTOR_IDS],
            )

    def test_no_writes_other_than_active_report_full_lifecycle(self):
        app = self._mb_app()
        with TestClient(app) as client:
            # Inline scan WITHOUT the helper's ``calls.clear()``: this
            # test asserts the ENTIRE SDK interaction surface of scan +
            # telemetry session together (ping comes from the scan).
            body = client.post("/api/robot/scan").json()
            self.assertEqual(body["status"], "connected", body)
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                ws.receive_json()
                # Let the session live long enough for the background poll
                # thread (2 ms cadence) to run at least one cycle.
                time.sleep(0.05)
        self.assertTrue(
            self._eventually(
                lambda: any(
                    not c[1] for c in FakeArSdk.active_report_calls()
                )
            )
        )
        motor_names = FakeArSdk.motor_method_names()
        ctrl_names = FakeArSdk.ctrl_method_names()
        # The ENTIRE SDK interaction surface of scan + telemetry session:
        self.assertEqual(
            motor_names,
            {
                "robstride_ping_host_id",
                "robstride_set_active_report",
                "get_state",
                "close",
            },
        )
        self.assertEqual(
            ctrl_names,
            {
                "__init__",
                "add_robstride_motor",
                "poll_feedback_once",
                "close_bus",
                "close",
            },
        )
        # ...and it intersects the forbidden set nowhere.
        self.assertEqual(motor_names & FORBIDDEN_SDK_CALLS, set())
        self.assertEqual(ctrl_names & FORBIDDEN_SDK_CALLS, set())
        # request_feedback (documented no-op for RobStride) never called.
        self.assertNotIn("request_feedback", motor_names)
        # Whitelist bookkeeping: exactly one authorized write, and it is not
        # in the forbidden set.
        self.assertEqual(
            ACTIVE_REPORT_AUTHORIZED_CALL, "robstride_set_active_report"
        )
        self.assertNotIn(ACTIVE_REPORT_AUTHORIZED_CALL, FORBIDDEN_SDK_CALLS)

    def test_frame_reports_null_for_silent_motors(self):
        # Only motor 1 has state; all others must be null (never fabricated).
        FakeArSdk.states[1] = _state(pos=1.25)
        app = self._mb_app()
        with TestClient(app) as client:
            self._scan_connected(client)
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                frame = ws.receive_json()
        joints = {j["id"]: j for j in frame["joints"]}
        self.assertEqual(joints[1]["position"], 1.25)
        self.assertEqual(joints[1]["freshness"], "fresh")
        for mid in (2, 3, 4, 5, 6, 7):
            self.assertIsNone(joints[mid]["position"])
            self.assertIsNone(joints[mid]["status_code"])
            self.assertEqual(joints[mid]["freshness"], "none")


# ---------------------------------------------------------------------------
# Hub-level slow-client policy (stdlib asyncio, no TestClient)
# ---------------------------------------------------------------------------


class HubSlowClientTests(_FakeSdkGuard):
    """Bounded keep-latest queue + cleanup, driven at the hub level."""

    class FakeService:
        def __init__(self):
            self._generation = 0

        @property
        def generation(self):
            return self._generation

        def bump(self):
            self._generation += 1

        def snapshot(self):
            return {"status": STATUS_CONNECTED}

    class SlowFakeWebSocket:
        def __init__(self, service, send_delay_s=0.1, stop_after=3):
            self._service = service
            self._send_delay_s = send_delay_s
            self._stop_after = stop_after
            self.sent = []
            self.closed = []

        async def send_json(self, frame):
            self.sent.append(frame)
            if len(self.sent) >= self._stop_after:
                self._service.bump()  # invalidate -> session must stop
            await asyncio.sleep(self._send_delay_s)  # slow client

        async def receive(self):
            await asyncio.sleep(3600)  # silent client

        async def close(self, code=1000):
            self.closed.append(code)

    def test_slow_client_gets_latest_frames_and_session_cleans_up(self):
        for mid in EXPECTED_MOTOR_IDS:
            FakeArSdk.states[mid] = _state(pos=mid * 1.0)
        service = self.FakeService()
        settings = Settings(
            adapter=ADAPTER_MOTORBRIDGE,
            allow_active_report_write=True,
            telemetry_hz=50.0,
        )
        hub = MotorbridgeTelemetryHub(settings, service)
        websocket = self.SlowFakeWebSocket(service)
        asyncio.run(hub.subscribe(websocket))

        sequences = [frame["sequence"] for frame in websocket.sent]
        self.assertEqual(len(sequences), 3)
        self.assertEqual(websocket.closed, [1000])
        # Keep-latest: at 50 Hz with 0.1 s per send, intermediate frames are
        # dropped — delivered sequences jump ahead instead of being 1, 2, 3.
        for older, newer in zip(sequences, sequences[1:]):
            self.assertGreater(newer, older)
        self.assertGreater(
            sequences[-1],
            len(sequences),
            f"expected dropped frames, got consecutive {sequences}",
        )
        # Authorized lifecycle completed by subscribe(): True once per motor,
        # then False once per motor after the generation bump, then release.
        self.assertEqual(
            FakeArSdk.active_report_calls(),
            [(mid, True) for mid in EXPECTED_MOTOR_IDS]
            + [(mid, False) for mid in EXPECTED_MOTOR_IDS],
        )
        self.assertEqual(len(FakeArSdk.motor_calls("close")), 7)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close")), 1)

    def test_frame_sink_observes_the_same_frames_without_own_device_read(self):
        for mid in EXPECTED_MOTOR_IDS:
            FakeArSdk.states[mid] = _state(pos=mid * 1.0)
        service = self.FakeService()
        settings = Settings(
            adapter=ADAPTER_MOTORBRIDGE,
            allow_active_report_write=True,
            telemetry_hz=50.0,
        )
        observed = []
        hub = MotorbridgeTelemetryHub(settings, service, frame_sink=observed.append)
        websocket = self.SlowFakeWebSocket(service, send_delay_s=0.01, stop_after=3)
        asyncio.run(hub.subscribe(websocket))

        self.assertGreaterEqual(len(observed), len(websocket.sent))
        sent_by_sequence = {frame["sequence"]: frame for frame in observed}
        for delivered in websocket.sent:
            # Identity proves the sink consumed the hub's already-built frame;
            # no recorder-specific read or reconstructed telemetry path exists.
            self.assertIs(sent_by_sequence[delivered["sequence"]], delivered)

    def test_hub_rejects_without_authorization_flag(self):
        service = self.FakeService()
        settings = Settings(
            adapter=ADAPTER_MOTORBRIDGE,
            allow_active_report_write=False,  # default OFF
            telemetry_hz=50.0,
        )
        hub = MotorbridgeTelemetryHub(settings, service)
        websocket = self.SlowFakeWebSocket(service)
        asyncio.run(hub.subscribe(websocket))
        # Exactly one error frame, policy-violation close code, and NO SDK
        # call of any kind — the gates run before anything is constructed.
        self.assertEqual(len(websocket.sent), 1)
        self.assertEqual(
            websocket.sent[0]["error"]["code"], "telemetry_not_allowed"
        )
        self.assertEqual(websocket.closed, [1008])
        self.assertEqual(FakeArSdk.calls, [])

    def test_disconnect_racing_send_stops_cleanly_and_cleans_up(self):
        """Phase 7G regression: a client close racing an in-flight frame
        send makes ``send_json`` raise (starlette WebSocketDisconnect).
        The stream must treat that as a normal end — subscribe() returns
        without propagating the exception AND the full authorized cleanup
        still runs (False once per motor + audited release)."""
        for mid in EXPECTED_MOTOR_IDS:
            FakeArSdk.states[mid] = _state(pos=mid * 1.0)
        service = self.FakeService()
        settings = Settings(
            adapter=ADAPTER_MOTORBRIDGE,
            allow_active_report_write=True,
            telemetry_hz=50.0,
        )
        hub = MotorbridgeTelemetryHub(settings, service)

        class SendFailWebSocket:
            """Silent client whose first delivered frame fails to send —
            exactly the Phase 7G race (disconnect mid-send)."""

            def __init__(self):
                self.send_attempts = 0
                self.closed = []

            async def send_json(self, frame):
                self.send_attempts += 1
                raise RuntimeError("client disconnected mid-send")

            async def receive(self):
                await asyncio.sleep(3600)  # silent client

            async def close(self, code=1000):
                self.closed.append(code)

        websocket = SendFailWebSocket()
        # Must NOT raise, no matter how the send failure surfaces.
        asyncio.run(hub.subscribe(websocket))

        self.assertGreaterEqual(websocket.send_attempts, 1)
        self.assertEqual(websocket.closed, [1000])
        # Authorized lifecycle completed despite the send failure: True
        # once per motor, then False once per motor, then audited release.
        self.assertEqual(
            FakeArSdk.active_report_calls(),
            [(mid, True) for mid in EXPECTED_MOTOR_IDS]
            + [(mid, False) for mid in EXPECTED_MOTOR_IDS],
        )
        self.assertEqual(len(FakeArSdk.motor_calls("close")), 7)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeArSdk.ctrl_calls("close")), 1)


class SharedTelemetryReadFailureTests(unittest.TestCase):
    """Transient shared-owner read faults must not flap the WebSocket."""

    class Service:
        def __init__(self, failures=0):
            self._generation = 0
            self.failures = failures
            self.calls = 0

        @property
        def generation(self):
            return self._generation

        def snapshot(self):
            return {"status": STATUS_CONNECTED}

        def bump(self):
            self._generation += 1

        def read_telemetry(self, sequence):
            self.calls += 1
            if self.failures:
                self.failures -= 1
                raise RuntimeError("temporary receive failure")
            return {
                "timestamp": "2026-08-11T00:00:00+00:00",
                "sequence": sequence,
                "channel": "can0",
                "source": "motorbridge",
                "units": dict(UNITS),
                "joints": [
                    {
                        "id": motor_id,
                        "position": float(motor_id),
                        "velocity": 0.0,
                        "torque": 0.0,
                        "current": None,
                        "temperature": {"mos": None, "rotor": None},
                        "status_code": 0,
                        "error_code": None,
                        "freshness": "fresh",
                    }
                    for motor_id in EXPECTED_MOTOR_IDS
                ],
            }

    class WebSocket:
        def __init__(self, service, stop_after=None):
            self.service = service
            self.stop_after = stop_after
            self.sent = []
            self.closed = []
            self.closed_when_first_frame = None

        async def send_json(self, frame):
            self.sent.append(frame)
            if len(self.sent) == 1:
                self.closed_when_first_frame = list(self.closed)
            if self.stop_after is not None and len(self.sent) >= self.stop_after:
                self.service.bump()
            await asyncio.sleep(0)

        async def receive(self):
            await asyncio.sleep(3600)

        async def close(self, code=1000):
            self.closed.append(code)

    def _settings(self):
        return Settings(
            adapter=ADAPTER_MOTORBRIDGE,
            allow_active_report_write=True,
            telemetry_hz=1000.0,
        )

    def test_single_read_failure_recovers_without_closing_or_new_controller(self):
        service = self.Service(failures=1)
        websocket = self.WebSocket(service, stop_after=2)
        hub = MotorbridgeTelemetryHub(self._settings(), service)

        asyncio.run(hub.subscribe(websocket))

        self.assertEqual(websocket.closed_when_first_frame, [])
        self.assertEqual([frame["sequence"] for frame in websocket.sent], [1, 2])
        self.assertEqual(websocket.closed, [1000])
        self.assertGreaterEqual(service.calls, 3)

    def test_consecutive_read_failures_fail_closed_at_bounded_threshold(self):
        service = self.Service(failures=100)
        websocket = self.WebSocket(service)
        hub = MotorbridgeTelemetryHub(self._settings(), service)

        asyncio.run(hub.subscribe(websocket))

        self.assertEqual(websocket.sent, [])
        self.assertEqual(websocket.closed, [1000])
        self.assertEqual(
            service.calls,
            activereport_module.TELEMETRY_READ_FAILURE_THRESHOLD,
        )


class SharedSessionBusContentionTests(unittest.TestCase):
    """Bus contention from aging/writes must not fail the telemetry session."""

    def test_bus_busy_is_normal_contention_not_fail_closed(self):
        class BusyService:
            def read_telemetry(self, sequence):
                raise BusBusyError("The CAN bus is held by aging_setup")

        session = SharedActiveReportSession(BusyService())
        for _ in range(TELEMETRY_READ_FAILURE_THRESHOLD + 10):
            self.assertIsNone(session.build_frame(1))
        # Exceeded many times should never raise TelemetryReadFailure.

    def test_scan_in_progress_is_normal_contention_not_fail_closed(self):
        class ScanningService:
            def read_telemetry(self, sequence):
                raise ScanInProgressError("scan in progress")

        session = SharedActiveReportSession(ScanningService())
        for _ in range(TELEMETRY_READ_FAILURE_THRESHOLD + 10):
            self.assertIsNone(session.build_frame(1))

    def test_genuine_read_error_still_fails_closed(self):
        class BrokenService:
            def read_telemetry(self, sequence):
                raise RuntimeError("controller gone")

        session = SharedActiveReportSession(BrokenService())
        for _ in range(TELEMETRY_READ_FAILURE_THRESHOLD - 1):
            self.assertIsNone(session.build_frame(1))
        with self.assertRaises(TelemetryReadFailure):
            session.build_frame(1)


if __name__ == "__main__":
    unittest.main()
