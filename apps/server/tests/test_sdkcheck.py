"""Tests for the motorbridge SDK version gate (``sdkcheck.py``) and its
startup/health integration (``app.py``, ``api.py``).

No hardware is touched: a fake ``motorbridge`` module shaped like the real
0.5.1 package (``__version__``, package-level ``abi_version()``) is injected
into ``sys.modules``.
"""

from __future__ import annotations

import sys
import types
import unittest

from rebot_server.config import ADAPTER_MOTORBRIDGE, ConfigError, Settings
from rebot_server.sdkcheck import (
    REQUIRED_MOTORBRIDGE_VERSION,
    import_verified_sdk,
    read_abi_version,
)

try:
    import httpx  # noqa: F401  (required by TestClient)
    from fastapi.testclient import TestClient

    from rebot_server.app import create_app

    _DEPS_AVAILABLE = True
except Exception:  # ImportError or broken install
    _DEPS_AVAILABLE = False


def _make_fake_module(
    version=REQUIRED_MOTORBRIDGE_VERSION,
    abi="fake-abi-0.5.1",
    with_version=True,
    with_abi=True,
    abi_raises=None,
):
    """Fake motorbridge module with the 0.5.1 package surface."""
    module = types.ModuleType("motorbridge")
    if with_version:
        module.__version__ = version
    module.get_version = lambda: version
    if with_abi:
        if abi_raises is not None:
            def _raise():
                raise abi_raises

            module.abi_version = _raise
        else:
            module.abi_version = lambda: abi
    module.Controller = object  # never constructed by these tests
    return module


class _SysModulesGuard(unittest.TestCase):
    """Save/restore sys.modules['motorbridge'] around every test."""

    def setUp(self):
        self._saved = sys.modules.get("motorbridge", "MISSING")

    def tearDown(self):
        if self._saved == "MISSING":
            sys.modules.pop("motorbridge", None)
        else:
            sys.modules["motorbridge"] = self._saved


class SdkGateUnitTests(_SysModulesGuard):
    def test_required_version_is_0_5_1(self):
        self.assertEqual(REQUIRED_MOTORBRIDGE_VERSION, "0.5.1")

    def test_exact_verified_version_accepted(self):
        sys.modules["motorbridge"] = _make_fake_module()
        module = import_verified_sdk()
        self.assertEqual(module.__version__, "0.5.1")

    def test_other_versions_rejected_fail_closed(self):
        # Anything but the exact verified release is rejected — including
        # "close" versions (the previously verified 0.4.9 included) and
        # non-string reports.
        for bad in ("0.3.8", "0.4.8", "0.4.9", "0.4.10", "0.5.0", "0.5.1rc1", 409):
            with self.subTest(version=bad):
                sys.modules["motorbridge"] = _make_fake_module(version=bad)
                with self.assertRaises(ConfigError) as ctx:
                    import_verified_sdk()
                message = str(ctx.exception)
                self.assertIn("unsupported motorbridge version", message)
                self.assertIn("0.5.1", message)

    def test_missing_version_attribute_rejected(self):
        sys.modules["motorbridge"] = _make_fake_module(with_version=False)
        with self.assertRaises(ConfigError):
            import_verified_sdk()

    def test_unimportable_sdk_rejected(self):
        sys.modules["motorbridge"] = None  # forces ImportError
        with self.assertRaises(ConfigError) as ctx:
            import_verified_sdk()
        self.assertIn("unavailable", str(ctx.exception))
        self.assertNotIn("Traceback", str(ctx.exception))

    def test_read_abi_version_ok(self):
        module = _make_fake_module()
        self.assertEqual(read_abi_version(module), "fake-abi-0.5.1")

    def test_read_abi_version_missing_callable_rejected(self):
        module = _make_fake_module(with_abi=False)
        with self.assertRaises(ConfigError):
            read_abi_version(module)

    def test_read_abi_version_native_load_failure_rejected(self):
        module = _make_fake_module(
            abi_raises=OSError("libmotor_abi cannot be loaded")
        )
        with self.assertRaises(ConfigError) as ctx:
            read_abi_version(module)
        message = str(ctx.exception)
        self.assertIn("ABI unavailable", message)
        self.assertNotIn("Traceback", message)

    def test_read_abi_version_empty_report_rejected(self):
        module = _make_fake_module(abi="")
        with self.assertRaises(ConfigError):
            read_abi_version(module)


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class StartupGateAppTests(_SysModulesGuard):
    def test_motorbridge_mode_starts_with_verified_sdk(self):
        sys.modules["motorbridge"] = _make_fake_module()
        app = create_app(settings=Settings(adapter=ADAPTER_MOTORBRIDGE))
        self.assertEqual(app.state.motorbridge_version, "0.5.1")
        self.assertEqual(app.state.motorbridge_abi_version, "fake-abi-0.5.1")

    def test_motorbridge_mode_refuses_wrong_version(self):
        sys.modules["motorbridge"] = _make_fake_module(version="0.5.0")
        with self.assertRaises(ConfigError):
            create_app(settings=Settings(adapter=ADAPTER_MOTORBRIDGE))

    def test_motorbridge_mode_refuses_missing_sdk(self):
        sys.modules["motorbridge"] = None
        with self.assertRaises(ConfigError):
            create_app(settings=Settings(adapter=ADAPTER_MOTORBRIDGE))

    def test_motorbridge_mode_refuses_broken_native_abi(self):
        sys.modules["motorbridge"] = _make_fake_module(
            abi_raises=RuntimeError("native lib missing")
        )
        with self.assertRaises(ConfigError):
            create_app(settings=Settings(adapter=ADAPTER_MOTORBRIDGE))

    def test_simulation_mode_never_imports_motorbridge(self):
        sys.modules.pop("motorbridge", None)
        app = create_app(settings=Settings())
        self.assertIsNone(app.state.motorbridge_version)
        self.assertIsNone(app.state.motorbridge_abi_version)
        self.assertNotIn("motorbridge", sys.modules)

    def test_health_reports_sdk_versions_in_motorbridge_mode(self):
        sys.modules["motorbridge"] = _make_fake_module()
        client = TestClient(
            create_app(settings=Settings(adapter=ADAPTER_MOTORBRIDGE))
        )
        body = client.get("/api/health").json()
        self.assertEqual(body["adapter"], "motorbridge")
        self.assertEqual(body["channel"], "can0")
        self.assertEqual(body["motorbridge_version"], "0.5.1")
        self.assertEqual(body["motorbridge_abi_version"], "fake-abi-0.5.1")

    def test_health_reports_null_sdk_versions_in_simulation_mode(self):
        sys.modules.pop("motorbridge", None)
        client = TestClient(create_app(settings=Settings()))
        body = client.get("/api/health").json()
        self.assertEqual(body["adapter"], "simulation")
        self.assertIsNone(body["motorbridge_version"])
        self.assertIsNone(body["motorbridge_abi_version"])
        # ...and answering health did not import the SDK.
        self.assertNotIn("motorbridge", sys.modules)

    def test_scan_via_app_in_motorbridge_mode_with_verified_fake(self):
        # End-to-end gate consistency: the startup gate and the per-scan gate
        # accept the same fake 0.5.1 SDK, and the read-only scan completes.
        from tests.test_motorbridge_scanner import FakeController, FakeSdk

        module = _make_fake_module()
        module.Controller = FakeController
        sys.modules["motorbridge"] = module
        FakeSdk.reset()
        client = TestClient(
            create_app(settings=Settings(adapter=ADAPTER_MOTORBRIDGE))
        )
        body = client.post("/api/robot/scan").json()
        self.assertEqual(body["status"], "connected")
        self.assertEqual(body["source"], "motorbridge")

    # ---- capabilities (Phase 5 requirement 12) ----

    def test_health_capabilities_simulation_mode(self):
        sys.modules.pop("motorbridge", None)
        client = TestClient(create_app(settings=Settings()))
        caps = client.get("/api/health").json()["capabilities"]
        self.assertEqual(
            caps,
            {
                "scan": True,
                "telemetry": True,  # simulation stream, no motor writes
                "enable": False,
                "control": False,
                "homing": False,
                "disable": False,
                "parameter_write": False,
                "persistent_gain_write": False,
                "mit_gain_write": False,
                "set_zero": False,
                "zero_torque": False,
                "active_report_write": False,
            },
        )

    def test_health_capabilities_motorbridge_flag_off(self):
        sys.modules["motorbridge"] = _make_fake_module()
        client = TestClient(
            create_app(settings=Settings(adapter=ADAPTER_MOTORBRIDGE))
        )
        caps = client.get("/api/health").json()["capabilities"]
        self.assertTrue(caps["scan"])
        # Not authorized -> no telemetry and no active-report write.
        self.assertFalse(caps["telemetry"])
        self.assertFalse(caps["active_report_write"])
        for key in ("control", "homing", "disable", "parameter_write"):
            self.assertFalse(caps[key], key)

    def test_health_capabilities_motorbridge_flag_on(self):
        sys.modules["motorbridge"] = _make_fake_module()
        client = TestClient(
            create_app(
                settings=Settings(
                    adapter=ADAPTER_MOTORBRIDGE,
                    allow_active_report_write=True,
                )
            )
        )
        caps = client.get("/api/health").json()["capabilities"]
        # Authorized AND SDK available (startup gate passed) -> both true.
        self.assertTrue(caps["scan"])
        self.assertTrue(caps["telemetry"])
        self.assertTrue(caps["active_report_write"])
        for key in ("control", "homing", "disable", "parameter_write"):
            self.assertFalse(caps[key], key)


if __name__ == "__main__":
    unittest.main()
