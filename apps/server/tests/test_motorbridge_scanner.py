"""MotorbridgeCanScanner tests against a fake ``motorbridge`` module shaped
like the REAL SDK 0.5.1 API (verified against the motorbridge 0.4.9 sdist
source, ``src/motorbridge/core.py`` and ``src/motorbridge/cli/scan.py``, and
re-verified byte-for-byte for 0.5.1 via sdist diff — Phase 7B):

    module.__version__ == "0.5.1"                     # version gate
    module.abi_version() -> str                       # package-level (health)
    controller = Controller(channel)                  # channel only
    motor = controller.add_robstride_motor(mid, fid, model) -> Motor
    motor.robstride_ping_host_id(host_id, timeout_ms) -> (device_id, responder_id)
    motor.close(); controller.close_bus(); controller.close()

No hardware is touched: a fake SDK module is injected into ``sys.modules``
and every interaction with it is recorded, which also lets us verify the
read-only guarantee — any forbidden SDK call is trapped loudly by the fakes'
``__getattr__`` and asserted against ``FORBIDDEN_SDK_CALLS``.
"""

from __future__ import annotations

import sys
import types
import unittest

from rebot_server.config import ADAPTER_MOTORBRIDGE, Settings
from rebot_server.models import EXPECTED_MOTOR_IDS
from rebot_server.scanners import create_scanner
from rebot_server.scanners.motorbridge import (
    FORBIDDEN_SDK_CALLS,
    MOTOR_MODELS,
    MotorbridgeCanScanner,
)
from rebot_server.sdkcheck import REQUIRED_MOTORBRIDGE_VERSION


class FakeSdk:
    """Shared recording / steering state for the fake SDK classes."""

    calls = []               # (scope, name, args, kwargs); scope: ctrl|motor
    instances = []           # FakeController instances
    replies = {}             # motor_id -> ping reply value (any shape)
    ping_errors = {}         # motor_id -> exception raised by ping
    add_errors = {}          # motor_id -> exception raised by add_robstride_motor
    controller_error = None  # raised by Controller.__init__
    close_bus_error = None   # raised by Controller.close_bus
    close_error = None       # raised by Controller.close
    motor_close_error = None  # raised by Motor.close

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.instances = []
        cls.replies = {}
        cls.ping_errors = {}
        cls.add_errors = {}
        cls.controller_error = None
        cls.close_bus_error = None
        cls.close_error = None
        cls.motor_close_error = None

    @classmethod
    def ctrl_calls(cls, name):
        return [c for c in cls.calls if c[0] == "ctrl" and c[1] == name]

    @classmethod
    def motor_calls(cls, name):
        return [c for c in cls.calls if c[0] == "motor" and c[1] == name]

    @classmethod
    def ctrl_method_names(cls):
        return {c[1] for c in cls.calls if c[0] == "ctrl"}

    @classmethod
    def motor_method_names(cls):
        return {c[1] for c in cls.calls if c[0] == "motor"}


class FakeMotor:
    """Motor handle with the real SDK's ping/close surface."""

    def __init__(self, motor_id, feedback_id, model):
        self.motor_id = motor_id
        self.feedback_id = feedback_id
        self.model = model

    def robstride_ping_host_id(self, host_id, timeout_ms=500):
        FakeSdk.calls.append(
            ("motor", "robstride_ping_host_id", (self.motor_id, host_id, timeout_ms), {})
        )
        return self._reply()

    def robstride_ping(self):
        FakeSdk.calls.append(("motor", "robstride_ping", (self.motor_id,), {}))
        return self._reply()

    def _reply(self):
        exc = FakeSdk.ping_errors.get(self.motor_id)
        if exc is not None:
            raise exc
        if self.motor_id in FakeSdk.replies:
            return FakeSdk.replies[self.motor_id]
        # Healthy default: echo the probed ID, responder = configured host ID.
        return (self.motor_id, self.feedback_id)

    def close(self):
        FakeSdk.calls.append(("motor", "close", (self.motor_id,), {}))
        if FakeSdk.motor_close_error is not None:
            raise FakeSdk.motor_close_error

    def __getattr__(self, name):
        # Tamper trap: any motor method the adapter should not call
        # (enable/disable/send_*/param writes/...) is recorded and fails
        # loudly instead of vanishing into a swallowed AttributeError.
        def _trap(*args, **kwargs):
            FakeSdk.calls.append(("motor", name, args, kwargs))
            raise AssertionError(f"unexpected motor SDK call: {name}")

        return _trap


class FakeController:
    """Controller with the real SDK signature: ``Controller(channel)`` only
    — passing any extra keyword (e.g. host_id) raises TypeError and fails the
    scan, which is exactly how the real SDK would reject it."""

    def __init__(self, channel):
        FakeSdk.calls.append(("ctrl", "__init__", (channel,), {}))
        FakeSdk.instances.append(self)
        self.channel = channel
        self.motors = []
        if FakeSdk.controller_error is not None:
            raise FakeSdk.controller_error

    def add_robstride_motor(self, motor_id, feedback_id, model):
        FakeSdk.calls.append(
            ("ctrl", "add_robstride_motor", (motor_id, feedback_id, model), {})
        )
        exc = FakeSdk.add_errors.get(motor_id)
        if exc is not None:
            raise exc
        motor = FakeMotor(motor_id, feedback_id, model)
        self.motors.append(motor)
        return motor

    def close_bus(self):
        FakeSdk.calls.append(("ctrl", "close_bus", (), {}))
        if FakeSdk.close_bus_error is not None:
            raise FakeSdk.close_bus_error

    def close(self):
        FakeSdk.calls.append(("ctrl", "close", (), {}))
        if FakeSdk.close_error is not None:
            raise FakeSdk.close_error

    def __getattr__(self, name):
        # Tamper trap for controller-level control calls (enable_all,
        # disable_all, shutdown, ...).
        def _trap(*args, **kwargs):
            FakeSdk.calls.append(("ctrl", name, args, kwargs))
            raise AssertionError(f"unexpected controller SDK call: {name}")

        return _trap


class UntimedOnlyMotor:
    """Older SDK shape: only the untimed ``robstride_ping()``. Deliberately
    does NOT define ``robstride_ping_host_id`` — the adapter must fail closed
    (status "error") and must NEVER use this method as a fallback."""

    def __init__(self, motor_id, feedback_id, model):
        self.motor_id = motor_id
        self.feedback_id = feedback_id
        self.model = model

    def robstride_ping(self):
        FakeSdk.calls.append(("motor", "robstride_ping", (self.motor_id,), {}))
        return (self.motor_id, self.feedback_id)

    def close(self):
        FakeSdk.calls.append(("motor", "close", (self.motor_id,), {}))


class UntimedOnlyController(FakeController):
    def add_robstride_motor(self, motor_id, feedback_id, model):
        FakeSdk.calls.append(
            ("ctrl", "add_robstride_motor", (motor_id, feedback_id, model), {})
        )
        motor = UntimedOnlyMotor(motor_id, feedback_id, model)
        self.motors.append(motor)
        return motor


class WrongSignatureMotor(FakeMotor):
    """Defines ``robstride_ping_host_id`` but with a WRONG signature
    (missing host_id / timeout_ms parameters)."""

    def robstride_ping_host_id(self):
        FakeSdk.calls.append(
            ("motor", "robstride_ping_host_id", (self.motor_id,), {})
        )
        return (self.motor_id, self.feedback_id)


class WrongSignatureController(FakeController):
    def add_robstride_motor(self, motor_id, feedback_id, model):
        FakeSdk.calls.append(
            ("ctrl", "add_robstride_motor", (motor_id, feedback_id, model), {})
        )
        motor = WrongSignatureMotor(motor_id, feedback_id, model)
        self.motors.append(motor)
        return motor


class MinimalController:
    """A controller exposing neither close_bus() nor close(): the adapter
    must drop the reference silently and still return a valid result."""

    def __init__(self, channel):
        FakeSdk.calls.append(("ctrl", "__init__", (channel,), {}))
        FakeSdk.instances.append(self)

    def add_robstride_motor(self, motor_id, feedback_id, model):
        FakeSdk.calls.append(
            ("ctrl", "add_robstride_motor", (motor_id, feedback_id, model), {})
        )
        return MinimalMotor(motor_id, feedback_id)


class MinimalMotor:
    def __init__(self, motor_id, feedback_id):
        self.motor_id = motor_id
        self.feedback_id = feedback_id

    def robstride_ping_host_id(self, host_id, timeout_ms=500):
        FakeSdk.calls.append(
            ("motor", "robstride_ping_host_id", (self.motor_id, host_id, timeout_ms), {})
        )
        return (self.motor_id, self.feedback_id)


class MotorbridgeScannerTests(unittest.TestCase):
    def setUp(self):
        FakeSdk.reset()
        self._saved_module = sys.modules.get("motorbridge", "MISSING")

    def tearDown(self):
        if self._saved_module == "MISSING":
            sys.modules.pop("motorbridge", None)
        else:
            sys.modules["motorbridge"] = self._saved_module

    def _install_fake_sdk(self, controller_cls=FakeController, version=REQUIRED_MOTORBRIDGE_VERSION):
        """Inject a fake ``motorbridge`` module with the 0.5.1 surface.

        ``version=None`` installs a module WITHOUT ``__version__`` (older
        SDK shape) to exercise the version gate's fail-closed path.
        """
        module = types.ModuleType("motorbridge")
        if version is not None:
            module.__version__ = version
        module.get_version = lambda: version
        module.abi_version = lambda: "fake-abi-0.5.1"
        module.Controller = controller_cls
        sys.modules["motorbridge"] = module

    # ---- happy path: real interface shape ----

    def test_all_motors_present_finds_all(self):
        self._install_fake_sdk()
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, tuple(EXPECTED_MOTOR_IDS))
        self.assertEqual(outcome.errors, {})

    def test_controller_opened_with_channel_positional_only(self):
        # Real SDK signature is Controller(channel) — no host_id kwarg.
        # FakeController.__init__ accepts exactly one positional argument, so
        # any extra kwarg from the adapter would TypeError and fail the scan.
        self._install_fake_sdk()
        outcome = MotorbridgeCanScanner(host_id=0xFD).scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(
            FakeSdk.ctrl_calls("__init__"),
            [("ctrl", "__init__", ("can0",), {})],
        )
        self.assertEqual(len(FakeSdk.instances), 1)

    def test_registration_order_models_and_host_id(self):
        self._install_fake_sdk()
        MotorbridgeCanScanner(host_id=0xFD).scan("can0", EXPECTED_MOTOR_IDS)
        adds = FakeSdk.ctrl_calls("add_robstride_motor")
        self.assertEqual(
            adds,
            [
                ("ctrl", "add_robstride_motor", (mid, 0xFD, MOTOR_MODELS[mid]), {})
                for mid in range(1, 8)
            ],
        )
        # Hardware mapping from rebotarm_rs.yaml: J1–J3 rs-06, J4–J7 rs-00.
        self.assertEqual(MOTOR_MODELS[1], "rs-06")
        self.assertEqual(MOTOR_MODELS[3], "rs-06")
        self.assertEqual(MOTOR_MODELS[4], "rs-00")
        self.assertEqual(MOTOR_MODELS[7], "rs-00")

    def test_ping_runs_serially_1_to_7_with_host_id_and_timeout(self):
        self._install_fake_sdk()
        MotorbridgeCanScanner(host_id=0xFD, ping_timeout_ms=500).scan(
            "can0", EXPECTED_MOTOR_IDS
        )
        pings = FakeSdk.motor_calls("robstride_ping_host_id")
        self.assertEqual(
            pings,
            [
                ("motor", "robstride_ping_host_id", (mid, 0xFD, 500), {})
                for mid in range(1, 8)
            ],
        )

    def test_configured_ping_timeout_is_passed_to_sdk(self):
        self._install_fake_sdk()
        MotorbridgeCanScanner(ping_timeout_ms=250).scan("can0", EXPECTED_MOTOR_IDS)
        timeouts = {c[2][2] for c in FakeSdk.motor_calls("robstride_ping_host_id")}
        self.assertEqual(timeouts, {250})

    def test_ping_timeout_is_clamped_to_safe_bounds(self):
        self._install_fake_sdk()
        MotorbridgeCanScanner(ping_timeout_ms=1).scan("can0", (1,))
        self.assertEqual(FakeSdk.motor_calls("robstride_ping_host_id")[0][2][2], 10)
        FakeSdk.reset()
        MotorbridgeCanScanner(ping_timeout_ms=10**9).scan("can0", (1,))
        self.assertEqual(FakeSdk.motor_calls("robstride_ping_host_id")[0][2][2], 2000)

    def test_read_only_call_surface_is_exactly_the_allowed_set(self):
        # The fakes record *every* call (and trap unknown ones via
        # __getattr__), so this asserts the adapter's entire SDK interaction
        # surface — controller and motor objects alike.
        self._install_fake_sdk()
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, tuple(EXPECTED_MOTOR_IDS))

        ctrl_names = FakeSdk.ctrl_method_names()
        motor_names = FakeSdk.motor_method_names()
        self.assertEqual(
            ctrl_names, {"__init__", "add_robstride_motor", "close_bus", "close"}
        )
        self.assertEqual(motor_names, {"robstride_ping_host_id", "close"})
        # The untimed legacy ping is never called — not even implicitly.
        self.assertNotIn("robstride_ping", motor_names)
        self.assertEqual(FakeSdk.motor_calls("robstride_ping"), [])
        self.assertEqual((ctrl_names | motor_names) & FORBIDDEN_SDK_CALLS, set())

        # Vendor scan cleanup pattern: close_bus exactly once (motors were
        # bound), controller close exactly once, one motor.close per motor.
        self.assertEqual(len(FakeSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeSdk.ctrl_calls("close")), 1)
        self.assertEqual(len(FakeSdk.motor_calls("close")), 7)

    def test_sdk_not_imported_for_simulation_and_lazy_for_motorbridge(self):
        # Requirement gating: the default adapter is simulation and must never
        # import the motorbridge SDK; selecting motorbridge builds the adapter
        # but still defers the SDK import until an actual scan.
        sys.modules.pop("motorbridge", None)
        sim = create_scanner(Settings())
        self.assertEqual(sim.source, "simulation")
        sim.scan("can0", EXPECTED_MOTOR_IDS)
        self.assertNotIn("motorbridge", sys.modules)
        mb = create_scanner(
            Settings(adapter=ADAPTER_MOTORBRIDGE, ping_timeout_ms=750)
        )
        self.assertEqual(mb.source, "motorbridge")
        self.assertNotIn("motorbridge", sys.modules)

    # ---- reply validation: device_id AND responder_id rules ----

    def test_wrong_device_id_echo_is_not_counted(self):
        self._install_fake_sdk()
        FakeSdk.replies = {3: (99, 0xFD)}  # motor 3 echoes a foreign ID
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, (1, 2, 4, 5, 6, 7))
        self.assertIn(3, outcome.errors)
        self.assertIn("unexpected device_id", outcome.errors[3])

    def test_malformed_ping_replies_are_never_counted(self):
        malformed = [
            None,                       # no reply object
            42,                         # not a sequence
            "1,253",                    # string, not a tuple
            (1,),                       # too short
            (1, 0xFD, 0),               # too long
            (None, 0xFD),               # non-int device_id
            (True, 0xFD),               # bool is not an int here
            (1, False),                 # bool responder_id
            (256, 0xFD),                # device_id out of byte range
            (1, -1),                    # responder_id negative
            (1, 256),                   # responder_id out of byte range
            (1.0, 0xFD),                # float device_id
            object(),                   # opaque object
        ]
        for bad_reply in malformed:
            with self.subTest(reply=bad_reply):
                FakeSdk.reset()
                self._install_fake_sdk()
                FakeSdk.replies = {4: bad_reply}
                outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
                self.assertIsNone(outcome.fatal_message)
                self.assertNotIn(4, outcome.found_ids)
                self.assertIn(4, outcome.errors)
                self.assertEqual(outcome.found_ids, (1, 2, 3, 5, 6, 7))

    def test_responder_id_may_differ_from_host_id(self):
        # Vendor evidence: motorbridge's own scan test accepts responder_id
        # 0xFE for host_id 0xFD as a valid hit. A legal responder byte is
        # therefore accepted even when it differs from the probed host ID —
        # as long as device_id matches.
        self._install_fake_sdk()
        FakeSdk.replies = {2: (2, 0xFE)}
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIn(2, outcome.found_ids)
        self.assertEqual(outcome.found_ids, tuple(EXPECTED_MOTOR_IDS))

    # ---- exception isolation ----

    def test_ping_exception_is_isolated_per_motor(self):
        self._install_fake_sdk()
        FakeSdk.ping_errors = {2: TimeoutError("ping timeout for motor 2")}
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        # No fatal: the scan continued through all other IDs.
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, (1, 3, 4, 5, 6, 7))
        self.assertIn(2, outcome.errors)
        self.assertIn("TimeoutError", outcome.errors[2])
        self.assertNotIn("Traceback", outcome.errors[2])
        # All IDs were still probed serially.
        pings = [c[2][0] for c in FakeSdk.motor_calls("robstride_ping_host_id")]
        self.assertEqual(pings, [1, 2, 3, 4, 5, 6, 7])

    def test_registration_failure_is_isolated_per_motor(self):
        self._install_fake_sdk()
        FakeSdk.add_errors = {5: RuntimeError("add_robstride_motor failed")}
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, (1, 2, 3, 4, 6, 7))
        self.assertIn(5, outcome.errors)
        self.assertIn("RuntimeError", outcome.errors[5])
        # The remaining motors were still probed and released.
        self.assertEqual(len(FakeSdk.motor_calls("close")), 6)
        self.assertEqual(len(FakeSdk.ctrl_calls("close_bus")), 1)

    def test_unknown_motor_id_is_recorded_not_probed(self):
        self._install_fake_sdk()
        outcome = MotorbridgeCanScanner().scan("can0", (1, 9))
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, (1,))
        self.assertIn(9, outcome.errors)
        self.assertIn("no motor model", outcome.errors[9])
        # No SDK registration/ping was attempted for the unknown ID.
        add_ids = [c[2][0] for c in FakeSdk.ctrl_calls("add_robstride_motor")]
        self.assertEqual(add_ids, [1])

    # ---- fail-closed paths ----

    def test_missing_sdk_fails_closed(self):
        # sys.modules[name] = None forces `import motorbridge` to raise.
        sys.modules["motorbridge"] = None
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        self.assertIn("motorbridge SDK unavailable", outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())

    def test_wrong_sdk_version_fails_closed(self):
        # Only the exact verified release (0.5.1) may drive a scan; any
        # other version aborts before any SDK object is constructed.
        self._install_fake_sdk(version="0.3.8")
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        self.assertIn("unsupported motorbridge version", outcome.fatal_message)
        self.assertIn("0.3.8", outcome.fatal_message)
        self.assertIn(REQUIRED_MOTORBRIDGE_VERSION, outcome.fatal_message)
        self.assertNotIn("Traceback", outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())
        # The gate runs first: no controller, no motors, no pings.
        self.assertEqual(FakeSdk.calls, [])

    def test_missing_sdk_version_attribute_fails_closed(self):
        # An SDK build without __version__ cannot be verified — fail closed.
        self._install_fake_sdk(version=None)
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        self.assertIn("unsupported motorbridge version", outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())
        self.assertEqual(FakeSdk.calls, [])

    def test_controller_construction_failure_fails_closed(self):
        self._install_fake_sdk()
        FakeSdk.controller_error = OSError("can0: no such device")
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        self.assertIn("scan aborted", outcome.fatal_message)
        self.assertNotIn("Traceback", outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())
        # Nothing was released because nothing was successfully created.
        self.assertEqual(FakeSdk.ctrl_calls("close_bus"), [])
        self.assertEqual(FakeSdk.ctrl_calls("close"), [])

    def test_invalid_channel_fails_closed_without_sdk_import(self):
        self._install_fake_sdk()
        outcome = MotorbridgeCanScanner().scan("vcan0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        # The fake SDK must never have been touched.
        self.assertEqual(FakeSdk.calls, [])

    # ---- cleanup robustness (vendor scan.py pattern) ----

    def test_cleanup_failures_do_not_break_scan_result(self):
        self._install_fake_sdk()
        FakeSdk.close_bus_error = OSError("close_bus failed")
        FakeSdk.close_error = OSError("close failed")
        FakeSdk.motor_close_error = OSError("motor close failed")
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, tuple(EXPECTED_MOTOR_IDS))
        # Every release attempt was still made.
        self.assertEqual(len(FakeSdk.motor_calls("close")), 7)
        self.assertEqual(len(FakeSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeSdk.ctrl_calls("close")), 1)

    def test_controller_without_close_methods_is_dropped_silently(self):
        self._install_fake_sdk(MinimalController)
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, tuple(EXPECTED_MOTOR_IDS))
        names = FakeSdk.ctrl_method_names()
        self.assertNotIn("close_bus", names)
        self.assertNotIn("close", names)

    def test_no_close_bus_when_no_motor_was_bound(self):
        # Vendor pattern: close_bus() only if at least one motor was added.
        self._install_fake_sdk()
        for mid in EXPECTED_MOTOR_IDS:
            FakeSdk.add_errors[mid] = RuntimeError("bind refused")
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())
        self.assertEqual(FakeSdk.ctrl_calls("close_bus"), [])
        self.assertEqual(len(FakeSdk.ctrl_calls("close")), 1)

    def test_missing_robstride_ping_host_id_fails_closed(self):
        # An SDK whose motor objects only expose the untimed robstride_ping()
        # must produce a fatal outcome (API status "error") — and the untimed
        # method must NEVER be used as a fallback.
        self._install_fake_sdk(UntimedOnlyController)
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        self.assertIn("incompatible", outcome.fatal_message)
        self.assertNotIn("Traceback", outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())
        self.assertEqual(outcome.errors, {})
        # The untimed ping was never attempted.
        self.assertEqual(FakeSdk.motor_calls("robstride_ping"), [])
        # Fail closed must not leak resources: the one created motor handle
        # and the controller were still released.
        self.assertEqual(len(FakeSdk.motor_calls("close")), 1)
        self.assertEqual(len(FakeSdk.ctrl_calls("close_bus")), 1)
        self.assertEqual(len(FakeSdk.ctrl_calls("close")), 1)

    def test_ping_signature_mismatch_fails_closed(self):
        # robstride_ping_host_id exists but does not accept
        # (host_id, timeout_ms) — still fail closed, no untimed fallback.
        self._install_fake_sdk(WrongSignatureController)
        outcome = MotorbridgeCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        self.assertIn("incompatible", outcome.fatal_message)
        self.assertNotIn("Traceback", outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())
        self.assertEqual(FakeSdk.motor_calls("robstride_ping"), [])


if __name__ == "__main__":
    unittest.main()
