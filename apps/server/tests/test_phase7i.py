"""Phase 7I safety contract tests; no hardware or motorbridge installation required."""

from __future__ import annotations

import threading
import unittest
from unittest import mock

from rebot_server.config import ADAPTER_MOTORBRIDGE, Settings, load_settings
from rebot_server.models import STATUS_CONNECTED
from rebot_server.service import AgingBusyError, ScanService, ServiceOperationError, ZeroTorqueBusyError
from rebot_server.writes import (
    RequiresConnectedError,
    WriteController,
    WriteNotAuthorizedError,
    ZeroTorqueNotAuthorizedError,
)
from rebot_server.scanners.motorbridge import MotorbridgeCanScanner


class RecordingScanner:
    source = "motorbridge"

    def __init__(self):
        self.calls = []
        self.release_count = 0
        self.zero_send = threading.Event()

    def scan(self, channel, expected_ids):
        self.calls.append("scan")
        from rebot_server.models import ScanOutcome

        return ScanOutcome(found_ids=tuple(expected_ids))

    def enable_all(self):
        self.calls.append("enable_all")

    def disable_all(self):
        self.calls.append("disable_all")

    def ensure_mit_mode(self):
        self.calls.append("ensure_mode_MIT")

    def send_zero_torque(self):
        self.calls.append(("send_mit", 0.0, 0.0, 0.0, 0.0, 0.0))
        self.zero_send.set()

    def send_aging_mit(self, positions):
        self.calls.append(("send_mit", tuple(positions), 0.0, 0.0, 0.0))

    def write_persistent_gains(self, changes):
        self.calls.append(("persistent_gains", changes))
        return {"motor_ids": [c["motor_id"] for c in changes], "parameter_ids": {"kp": 0x701E, "kd": 0x701F}}

    def set_mechanical_zero(self):
        self.calls.extend(("disable_motor", "read_0x7019", "set_zero_position", "store_parameters"))
        return {"motor_ids": list(range(1, 8)), "parameter_id": 0x7019, "previous_positions": {i: 1.0 for i in range(1, 8)}}

    def release(self):
        self.release_count += 1


class Phase7IWriteTests(unittest.TestCase):
    def _connected(self, *, gate=True):
        scanner = RecordingScanner()
        service = ScanService(scanner, "can1")
        settings = Settings(
            adapter=ADAPTER_MOTORBRIDGE,
            channel="can1",
            allow_enable_write=gate,
            allow_parameter_write=gate,
            allow_zero_torque_write=gate,
            allow_set_zero_write=gate,
        )
        return scanner, service, WriteController(settings, service)

    def test_gate_defaults_closed_and_touches_nothing(self):
        scanner, service, writes = self._connected(gate=False)
        with self.assertRaises(WriteNotAuthorizedError):
            writes.enable_all()
        self.assertEqual(scanner.calls, [])

    def test_requires_full_connection(self):
        scanner, service, writes = self._connected()
        with self.assertRaises(RequiresConnectedError):
            writes.disable_all()
        self.assertEqual(scanner.calls, [])

    def test_only_manual_enable_and_disable_reuse_shared_service_owner(self):
        scanner, service, writes = self._connected()
        self.assertEqual(service.run_scan()["status"], STATUS_CONNECTED)
        writes.enable_all()
        writes.disable_all()
        self.assertEqual(scanner.calls, ["scan", "enable_all", "disable_all"])
        self.assertFalse(hasattr(writes, "write_parameters"))
        self.assertFalse(hasattr(writes, "read_parameters"))

    def test_concurrent_manual_click_is_fail_closed(self):
        scanner, service, writes = self._connected()
        service.run_scan()
        held = threading.Event()
        release = threading.Event()

        original = scanner.enable_all

        def slow_enable():
            held.set()
            release.wait(1)
            original()

        scanner.enable_all = slow_enable
        errors = []

        def run():
            try:
                writes.enable_all()
            except Exception as exc:  # pragma: no cover - diagnostic
                errors.append(exc)

        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(held.wait(1))
        with self.assertRaises(Exception):
            writes.disable_all()
        release.set()
        thread.join(1)
        self.assertEqual(errors, [])

    def test_environment_gate_parses_fail_closed(self):
        settings = load_settings(
            {
                "REBOT_ADAPTER": "motorbridge",
                "REBOT_CAN_CHANNEL": "can1",
                "REBOT_ALLOW_ENABLE_WRITE": "unexpected",
            }
        )
        self.assertFalse(settings.allow_enable_write)

    def test_persistent_scan_configures_once_and_releases_without_control(self):
        calls = []

        class Motor:
            def __init__(self, motor_id):
                self.motor_id = motor_id

            def robstride_ping_host_id(self, host_id, timeout_ms):
                calls.append(("ping", self.motor_id))
                return self.motor_id, 0xFE

            def robstride_set_active_report(self, enabled):
                calls.append(("active_report", self.motor_id, enabled))

            def close(self):
                calls.append(("motor_close", self.motor_id))

        class Controller:
            def __init__(self, channel):
                calls.append(("controller", channel))

            def add_robstride_motor(self, motor_id, host_id, model):
                calls.append(("add", motor_id, model))
                return Motor(motor_id)

            def close_bus(self):
                calls.append(("close_bus",))

            def close(self):
                calls.append(("close",))

        fake_module = type("Sdk", (), {"__version__": "0.5.1", "Controller": Controller})
        scanner = MotorbridgeCanScanner(
            host_id=0xFD,
            persist=True,
            allow_active_report=True,
            module_name="phase7i_fake_sdk",
        )
        with mock.patch("importlib.import_module", return_value=fake_module):
            outcome = scanner.scan("can1", (1, 2, 3, 4, 5, 6, 7))
            self.assertEqual(outcome.found_ids, (1, 2, 3, 4, 5, 6, 7))
            self.assertEqual(
                [c for c in calls if c[0] == "active_report"],
                [("active_report", mid, True) for mid in range(1, 8)],
            )
            self.assertEqual([c for c in calls if c[0] == "controller"], [("controller", "can1")])
            scanner.release()
        self.assertEqual(
            [c for c in calls if c[0] == "active_report"],
            [("active_report", mid, True) for mid in range(1, 8)]
            + [("active_report", mid, False) for mid in range(1, 8)],
        )
        self.assertNotIn(("enable_all",), calls)
        self.assertNotIn(("disable_all",), calls)

    def test_zero_torque_exact_sequence_and_stop_order(self):
        scanner, service, writes = self._connected()
        service.run_scan()
        status = writes.start_zero_torque()
        self.assertIn(status["status"], {"active", "starting"})
        self.assertTrue(scanner.zero_send.wait(1))
        stop = writes.stop_zero_torque()
        self.assertEqual(stop["status"], "inactive")
        names = [c if isinstance(c, str) else c[0] for c in scanner.calls]
        self.assertEqual(names[:3], ["scan", "enable_all", "ensure_mode_MIT"])
        self.assertGreaterEqual(names.count("send_mit"), 1)
        self.assertEqual(names[-1], "disable_all")
        for call in scanner.calls:
            if isinstance(call, tuple) and call[0] == "send_mit":
                self.assertEqual(call[1:], (0.0, 0.0, 0.0, 0.0, 0.0))

    def test_zero_torque_is_bus_exclusive_and_gate_closed_touches_nothing(self):
        scanner, service, writes = self._connected(gate=False)
        service.run_scan()
        with self.assertRaises(ZeroTorqueNotAuthorizedError):
            writes.start_zero_torque()
        self.assertNotIn("enable_all", scanner.calls)
        self.assertNotIn("ensure_mode_MIT", scanner.calls)

        scanner, service, writes = self._connected()
        service.run_scan()
        writes.start_zero_torque()
        with self.assertRaises(ZeroTorqueBusyError):
            service.run_scan()
        service.try_acquire_bus("telemetry")
        service.release_bus()
        writes.stop_zero_torque()

    def test_aging_reuses_shared_owner_and_is_bus_exclusive(self):
        scanner, service, _writes = self._connected()
        service.run_scan()
        service.begin_aging_motion()
        service.send_aging_positions([0.1] * 7, [0.5] * 7)
        with self.assertRaises(AgingBusyError):
            service.run_scan()
        service.try_acquire_bus("telemetry")
        service.release_bus()
        service.finish_aging_motion(disable=True)
        self.assertEqual(scanner.calls[1:4], ["disable_all", "ensure_mode_MIT", "enable_all"])
        self.assertEqual(scanner.calls[-1], "disable_all")

    def test_aging_auto_exits_zero_torque_before_motion(self):
        scanner, service, writes = self._connected()
        service.run_scan()
        writes.start_zero_torque()
        self.assertEqual(service.zero_torque_status()["status"], "active")
        service.begin_aging_motion()
        # aging motion is allowed only after zero-torque is exited automatically
        self.assertEqual(service.zero_torque_status()["status"], "inactive")
        self.assertIn("enable_all", scanner.calls)
        self.assertIn("ensure_mode_MIT", scanner.calls)
        service.finish_aging_motion(disable=True)

    def test_aging_refused_when_zero_torque_cannot_exit(self):
        scanner, service, writes = self._connected()
        service.run_scan()
        writes.start_zero_torque()
        with mock.patch.object(
            service, "run_zero_torque_stop", side_effect=ServiceOperationError("boom")
        ):
            with self.assertRaises(ZeroTorqueBusyError):
                service.begin_aging_motion()
        writes.stop_zero_torque()

    def test_persistent_gain_path_is_separate_and_validated(self):
        scanner, service, writes = self._connected()
        service.run_scan()
        result = writes.write_persistent_gains([
            type("Change", (), {"motor_id": 1, "kp": 13.0, "kd": 12.0})()
        ])
        self.assertEqual(result["operation"], "persistent_gain_write")
        self.assertEqual(scanner.calls[-1][0], "persistent_gains")
        with self.assertRaises(Exception):
            writes.write_persistent_gains([
                type("Change", (), {"motor_id": 8, "kp": 1.0, "kd": 1.0})()
            ])
        self.assertNotIn("send_mit", [c if isinstance(c, str) else c[0] for c in scanner.calls])

    def test_mechanical_zero_reuses_owner_and_records_reference_sequence(self):
        scanner, service, writes = self._connected()
        service.run_scan()
        result = writes.set_zero()
        self.assertEqual(result["operation"], "set_mechanical_zero")
        self.assertEqual(result["parameter_id"], 0x7019)
        self.assertEqual(
            scanner.calls[-4:],
            ["disable_motor", "read_0x7019", "set_zero_position", "store_parameters"],
        )

    def test_mechanical_zero_gate_closed_touches_nothing(self):
        scanner, service, writes = self._connected(gate=False)
        service.run_scan()
        with self.assertRaises(Exception):
            writes.set_zero()
        self.assertEqual(scanner.calls, ["scan"])


if __name__ == "__main__":
    unittest.main()
