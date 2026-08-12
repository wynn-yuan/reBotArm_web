"""API contract tests via FastAPI TestClient.

These skip automatically when fastapi/httpx are not installed (the core test
suite is stdlib-only). No CAN hardware is involved — only the simulation
adapter and fakes.
"""

from __future__ import annotations

import sys
import threading
import time
import unittest

from rebot_server.config import Settings
from rebot_server.models import EXPECTED_MOTOR_IDS

try:
    import httpx  # noqa: F401  (required by TestClient)
    from fastapi.testclient import TestClient

    from rebot_server.app import create_app

    _DEPS_AVAILABLE = True
except Exception:  # ImportError or broken install
    _DEPS_AVAILABLE = False


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class ApiContractTests(unittest.TestCase):
    def _app(self, **settings_overrides):
        return create_app(settings=Settings(**settings_overrides))

    def setUp(self):
        self.client = TestClient(self._app())

    def test_health(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["service"], "rebot-server")
        self.assertEqual(body["adapter"], "simulation")
        self.assertEqual(body["channel"], "can0")
        # Simulation mode: SDK fields are null (SDK never imported).
        self.assertIsNone(body["motorbridge_version"])
        self.assertIsNone(body["motorbridge_abi_version"])
        self.assertTrue(body["version"])
        self.assertTrue(body["time"])

    def test_health_capabilities_contract_simulation(self):
        # Phase 7A: capabilities is part of the /api/health contract. In
        # simulation mode scan+telemetry are available; every write capability
        # (including the single authorized active-report toggle) is false.
        body = self.client.get("/api/health").json()
        caps = body["capabilities"]
        self.assertEqual(
            caps,
            {
                "scan": True,
                "telemetry": True,
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

    def test_safe_capabilities_fallback_is_fail_closed(self):
        # Defense in depth: when app.state.capabilities is absent, get_health
        # falls back to _SAFE_CAPABILITIES. That fallback must itself be
        # fail-closed — never claim a write capability.
        from rebot_server.api import _SAFE_CAPABILITIES

        self.assertEqual(_SAFE_CAPABILITIES["telemetry"], False)
        self.assertEqual(_SAFE_CAPABILITIES["control"], False)
        self.assertEqual(_SAFE_CAPABILITIES["homing"], False)
        self.assertEqual(_SAFE_CAPABILITIES["disable"], False)
        self.assertEqual(_SAFE_CAPABILITIES["parameter_write"], False)
        self.assertEqual(_SAFE_CAPABILITIES["active_report_write"], False)
        self.assertEqual(_SAFE_CAPABILITIES["scan"], True)

    def test_health_in_simulation_mode_never_imports_motorbridge(self):
        sys.modules.pop("motorbridge", None)
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("motorbridge", sys.modules)

    def test_connection_initial_state(self):
        response = self.client.get("/api/robot/connection")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "disconnected")
        self.assertEqual(body["channel"], "can0")
        self.assertEqual(body["expected_ids"], [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(body["found_ids"], [])
        self.assertEqual(body["missing_ids"], [])

    def test_connection_responses_include_capabilities(self):
        # The connection endpoints must carry the same startup-established
        # capabilities as /api/health so a client restoring only the
        # connection state can gate telemetry fail-closed (no source guess).
        health_caps = self.client.get("/api/health").json()["capabilities"]

        initial = self.client.get("/api/robot/connection").json()
        self.assertEqual(initial["capabilities"], health_caps)

        scanned = self.client.post("/api/robot/scan").json()
        self.assertEqual(scanned["status"], "connected")
        self.assertEqual(scanned["capabilities"], health_caps)

        disconnected = self.client.post("/api/robot/disconnect").json()
        self.assertEqual(disconnected["status"], "disconnected")
        self.assertEqual(disconnected["capabilities"], health_caps)

        restored = self.client.get("/api/robot/connection").json()
        self.assertEqual(restored["capabilities"], health_caps)

    def test_connection_capabilities_fallback_is_fail_closed(self):
        # Defense in depth: when app.state.capabilities is absent the
        # connection endpoints fall back to _SAFE_CAPABILITIES (same
        # semantics as get_health) — never claim telemetry/writes.
        from rebot_server.api import _SAFE_CAPABILITIES

        app = self._app()
        del app.state.capabilities
        with TestClient(app) as client:
            body = client.get("/api/robot/connection").json()
        self.assertEqual(body["capabilities"], _SAFE_CAPABILITIES)
        self.assertFalse(body["capabilities"]["telemetry"])

    def test_scan_returns_full_contract_and_connected(self):
        response = self.client.post("/api/robot/scan")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "connected")
        self.assertEqual(body["channel"], "can0")
        self.assertEqual(body["expected_ids"], list(EXPECTED_MOTOR_IDS))
        self.assertEqual(body["found_ids"], list(EXPECTED_MOTOR_IDS))
        self.assertEqual(body["missing_ids"], [])
        self.assertIsNotNone(body["started_at"])
        self.assertIsNotNone(body["completed_at"])
        self.assertEqual(body["source"], "simulation")
        self.assertTrue(body["message"])

    def test_get_connection_returns_last_scan_result(self):
        self.client.post("/api/robot/scan")
        response = self.client.get("/api/robot/connection")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "connected")

    def test_scan_partial_when_ids_missing(self):
        client = TestClient(self._app(sim_found_ids=(1, 2, 3)))
        response = client.post("/api/robot/scan")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "partial")
        self.assertEqual(body["found_ids"], [1, 2, 3])
        self.assertEqual(body["missing_ids"], [4, 5, 6, 7])

    def test_scan_error_when_adapter_fails(self):
        client = TestClient(self._app(sim_fatal_error=True))
        response = client.post("/api/robot/scan")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "error")
        self.assertEqual(body["found_ids"], [])
        self.assertEqual(body["missing_ids"], list(EXPECTED_MOTOR_IDS))
        self.assertNotIn("Traceback", body["message"])

    def test_scan_ignores_request_body_expected_ids_fixed(self):
        response = self.client.post(
            "/api/robot/scan", json={"expected_ids": [1], "channel": "can9"}
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["channel"], "can0")
        self.assertEqual(body["expected_ids"], list(EXPECTED_MOTOR_IDS))

    def test_concurrent_scan_returns_409(self):
        app = self._app(sim_scan_delay_s=2.0)
        results = {}

        def do_scan(index):
            with TestClient(app) as client:
                response = client.post("/api/robot/scan")
                results[index] = (response.status_code, response.json())

        threads = [threading.Thread(target=do_scan, args=(i,)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
        for thread in threads:
            self.assertFalse(thread.is_alive())

        codes = sorted(code for code, _ in results.values())
        self.assertEqual(codes, [200, 409], f"unexpected results: {results}")
        conflict = next(body for code, body in results.values() if code == 409)
        self.assertEqual(conflict["error"]["code"], "scan_in_progress")

    def test_disconnect_clears_state(self):
        self.client.post("/api/robot/scan")
        self.assertEqual(self.client.get("/api/robot/connection").json()["status"], "connected")

        response = self.client.post("/api/robot/disconnect")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "disconnected")
        self.assertEqual(body["found_ids"], [])
        self.assertEqual(body["missing_ids"], [])
        self.assertIsNone(body["started_at"])
        self.assertIsNone(body["completed_at"])

        follow_up = self.client.get("/api/robot/connection")
        self.assertEqual(follow_up.json()["status"], "disconnected")

    def test_disconnect_during_active_scan_keeps_disconnected(self):
        # HTTP-level race: disconnect while a scan is in flight. The stale
        # scan must not resurrect 'connected' after completing.
        app = self._app(sim_scan_delay_s=1.5)
        results = {}

        def do_scan():
            with TestClient(app) as client:
                response = client.post("/api/robot/scan")
                results["scan"] = (response.status_code, response.json())

        thread = threading.Thread(target=do_scan)
        thread.start()
        try:
            with TestClient(app) as client:
                # Wait until the scan is actually in progress.
                deadline = time.monotonic() + 10
                body = None
                while True:
                    body = client.get("/api/robot/connection").json()
                    if body["status"] == "scanning":
                        break
                    if time.monotonic() > deadline:
                        self.fail(f"scan did not start in time: {body}")
                    time.sleep(0.02)
                # Disconnect immediately; must return 'disconnected' at once.
                response = client.post("/api/robot/disconnect")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["status"], "disconnected")
                self.assertEqual(
                    client.get("/api/robot/connection").json()["status"],
                    "disconnected",
                )
        finally:
            thread.join(timeout=15)
        self.assertFalse(thread.is_alive())

        # The stale scan's own HTTP response reports the cleared state...
        code, body = results["scan"]
        self.assertEqual(code, 200)
        self.assertEqual(body["status"], "disconnected")

        # ...and the service stayed disconnected afterwards; a new scan works.
        with TestClient(app) as client:
            self.assertEqual(
                client.get("/api/robot/connection").json()["status"],
                "disconnected",
            )
            self.assertEqual(
                client.post("/api/robot/scan").json()["status"], "connected"
            )


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class ApiCorsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app(settings=Settings()))

    def _preflight(self, origin):
        return self.client.options(
            "/api/robot/connection",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )

    def test_localhost_origin_allowed_by_default(self):
        response = self._preflight("http://localhost:3000")
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://localhost:3000",
        )

    def test_loopback_origin_allowed_by_default(self):
        response = self._preflight("http://127.0.0.1:5173")
        self.assertEqual(
            response.headers.get("access-control-allow-origin"),
            "http://127.0.0.1:5173",
        )

    def test_foreign_origin_denied_by_default(self):
        response = self._preflight("http://evil.example")
        self.assertNotIn("access-control-allow-origin", response.headers)


if __name__ == "__main__":
    unittest.main()
