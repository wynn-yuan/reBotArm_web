"""ScanService state-machine tests (stdlib only, no hardware)."""

from __future__ import annotations

import threading
import time
import unittest

from rebot_server.config import ConfigError
from rebot_server.models import (
    EXPECTED_MOTOR_IDS,
    STATUS_CONNECTED,
    STATUS_DISCONNECTED,
    STATUS_ERROR,
    STATUS_PARTIAL,
    STATUS_SCANNING,
    ScanOutcome,
)
from rebot_server.scanners.base import CanScanner
from rebot_server.service import ScanInProgressError, ScanService


class FakeScanner(CanScanner):
    source = "fake"

    def __init__(self, outcome=None, error=None, gate=None):
        self.outcome = outcome if outcome is not None else ScanOutcome(
            found_ids=tuple(EXPECTED_MOTOR_IDS)
        )
        self.error = error          # exception instance to raise from scan()
        self.gate = gate            # threading.Event to block on (slow scan)
        self.scan_calls = []
        self.release_calls = 0

    def scan(self, channel, expected_ids):
        self.scan_calls.append((channel, tuple(expected_ids)))
        if self.gate is not None:
            self.gate.wait(timeout=10)
        if self.error is not None:
            raise self.error
        return self.outcome

    def release(self):
        self.release_calls += 1


class TelemetryScanner(FakeScanner):
    def __init__(self):
        super().__init__()
        self.poll_calls = 0

    def poll_feedback(self):
        self.poll_calls += 1

    def telemetry_motors(self):
        return {}


class ServiceStateTests(unittest.TestCase):
    def _service(self, scanner=None):
        scanner = scanner or FakeScanner()
        return ScanService(scanner, "can0"), scanner

    def test_initial_state_is_disconnected_without_scan_info(self):
        service, _ = self._service()
        snap = service.snapshot()
        self.assertEqual(snap["status"], STATUS_DISCONNECTED)
        self.assertEqual(snap["channel"], "can0")
        self.assertEqual(snap["expected_ids"], [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(snap["found_ids"], [])
        self.assertEqual(snap["missing_ids"], [])
        self.assertIsNone(snap["started_at"])
        self.assertIsNone(snap["completed_at"])
        self.assertIsNone(snap["source"])

    def test_all_ids_found_is_connected(self):
        service, scanner = self._service()
        result = service.run_scan()
        self.assertEqual(result["status"], STATUS_CONNECTED)
        self.assertEqual(result["found_ids"], [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(result["missing_ids"], [])
        self.assertEqual(result["source"], "fake")
        self.assertIsNotNone(result["started_at"])
        self.assertIsNotNone(result["completed_at"])
        # The adapter received the backend-fixed expected IDs.
        self.assertEqual(scanner.scan_calls, [("can0", tuple(EXPECTED_MOTOR_IDS))])

    def test_missing_any_id_is_partial_never_connected(self):
        outcome = ScanOutcome(found_ids=(1, 2, 3, 4, 5, 6))  # 7 missing
        service, _ = self._service(FakeScanner(outcome=outcome))
        result = service.run_scan()
        self.assertEqual(result["status"], STATUS_PARTIAL)
        self.assertEqual(result["found_ids"], [1, 2, 3, 4, 5, 6])
        self.assertEqual(result["missing_ids"], [7])
        self.assertIn("7", result["message"])

    def test_no_ids_found_is_still_partial_not_error(self):
        outcome = ScanOutcome(found_ids=())
        service, _ = self._service(FakeScanner(outcome=outcome))
        result = service.run_scan()
        self.assertEqual(result["status"], STATUS_PARTIAL)
        self.assertEqual(result["missing_ids"], [1, 2, 3, 4, 5, 6, 7])

    def test_fatal_outcome_is_error_with_all_ids_missing(self):
        outcome = ScanOutcome(fatal_message="can0 could not be opened")
        service, _ = self._service(FakeScanner(outcome=outcome))
        result = service.run_scan()
        self.assertEqual(result["status"], STATUS_ERROR)
        self.assertEqual(result["found_ids"], [])
        self.assertEqual(result["missing_ids"], [1, 2, 3, 4, 5, 6, 7])
        self.assertIn("can0 could not be opened", result["message"])

    def test_scanner_exception_becomes_error_without_stacktrace(self):
        error = ValueError("boom with\nmultiple lines")
        service, _ = self._service(FakeScanner(error=error))
        result = service.run_scan()
        self.assertEqual(result["status"], STATUS_ERROR)
        self.assertIn("ValueError", result["message"])
        self.assertNotIn("Traceback", result["message"])
        self.assertNotIn("\n", result["message"])

    def test_get_returns_latest_result(self):
        service, scanner = self._service()
        service.run_scan()
        first = service.snapshot()
        # Switch adapter behavior and scan again — state must follow the last scan.
        scanner.outcome = ScanOutcome(found_ids=(1,))
        service.run_scan()
        second = service.snapshot()
        self.assertEqual(first["status"], STATUS_CONNECTED)
        self.assertEqual(second["status"], STATUS_PARTIAL)
        self.assertEqual(second["found_ids"], [1])

    def test_snapshot_returns_a_copy(self):
        service, _ = self._service()
        snap = service.snapshot()
        snap["status"] = "tampered"
        snap["found_ids"].append(99)
        self.assertEqual(service.snapshot()["status"], STATUS_DISCONNECTED)
        self.assertEqual(service.snapshot()["found_ids"], [])

    def test_channel_is_validated_at_construction(self):
        with self.assertRaises(ConfigError):
            ScanService(FakeScanner(), "vcan0")


class ServiceConcurrencyTests(unittest.TestCase):
    def test_concurrent_scan_is_rejected(self):
        gate = threading.Event()
        scanner = FakeScanner(gate=gate)
        service = ScanService(scanner, "can0")

        result_holder = {}

        def worker():
            try:
                result_holder["result"] = service.run_scan()
            except Exception as exc:  # pragma: no cover - should not happen
                result_holder["error"] = exc

        thread = threading.Thread(target=worker)
        thread.start()
        try:
            # Wait until the scan is actually in progress.
            deadline = time.monotonic() + 5
            while service.snapshot()["status"] != STATUS_SCANNING:
                if time.monotonic() > deadline:
                    self.fail("scan did not enter 'scanning' state in time")
                time.sleep(0.005)
            # A concurrent scan must be rejected.
            with self.assertRaises(ScanInProgressError):
                service.run_scan()
        finally:
            gate.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertNotIn("error", result_holder)
        self.assertEqual(result_holder["result"]["status"], STATUS_CONNECTED)
        self.assertEqual(service.snapshot()["status"], STATUS_CONNECTED)

    def test_scan_lock_released_after_scan(self):
        service = ScanService(FakeScanner(), "can0")
        service.run_scan()
        # Immediately runnable again — the mutex must be released.
        result = service.run_scan()
        self.assertEqual(result["status"], STATUS_CONNECTED)

    def test_telemetry_waits_for_short_zero_torque_bus_hold(self):
        scanner = TelemetryScanner()
        service = ScanService(scanner, "can0")
        service.try_acquire_bus("zero")
        result_holder = {}

        def read_frame():
            try:
                result_holder["frame"] = service.read_telemetry(7)
            except Exception as exc:  # pragma: no cover - should not happen
                result_holder["error"] = exc

        thread = threading.Thread(target=read_frame)
        thread.start()
        time.sleep(0.01)
        service.release_bus()
        thread.join(timeout=2)

        self.assertFalse(thread.is_alive())
        self.assertNotIn("error", result_holder)
        self.assertEqual(result_holder["frame"]["sequence"], 7)
        self.assertEqual(scanner.poll_calls, 1)

    def test_telemetry_timeout_reports_actual_scan_owner(self):
        service = ScanService(TelemetryScanner(), "can0")
        service.try_acquire_bus("scan")
        try:
            with self.assertRaises(ScanInProgressError):
                service.read_telemetry(1)
        finally:
            service.release_bus()

    def _wait_for_scanning(self, service, timeout=5.0):
        deadline = time.monotonic() + timeout
        while service.snapshot()["status"] != STATUS_SCANNING:
            if time.monotonic() > deadline:
                self.fail("scan did not enter 'scanning' state in time")
            time.sleep(0.005)

    def test_disconnect_during_active_scan_returns_disconnected_immediately(self):
        # Race case 1+2: disconnect while a scan is in flight must return
        # immediately and report 'disconnected' — it must not block on the
        # running scan.
        gate = threading.Event()
        scanner = FakeScanner(gate=gate)
        service = ScanService(scanner, "can0")

        thread = threading.Thread(target=service.run_scan)
        thread.start()
        try:
            self._wait_for_scanning(service)
            cleared = service.disconnect()
            self.assertEqual(cleared["status"], STATUS_DISCONNECTED)
            # State is cleared right away, even though the scan still runs.
            self.assertEqual(service.snapshot()["status"], STATUS_DISCONNECTED)
        finally:
            gate.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())

    def test_stale_scan_completion_keeps_disconnected(self):
        # Race case 3: when the in-flight (stale) scan finishes AFTER the
        # disconnect, its result must be discarded — never resurrecting
        # 'connected'/'partial' over the cleared state.
        gate = threading.Event()
        scanner = FakeScanner(gate=gate)  # would report all IDs -> connected
        service = ScanService(scanner, "can0")

        stale_result = {}

        def stale_scan():
            stale_result["result"] = service.run_scan()

        thread = threading.Thread(target=stale_scan)
        thread.start()
        try:
            self._wait_for_scanning(service)
            service.disconnect()
        finally:
            gate.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        # The stale scan's own return value reflects the cleared state...
        self.assertEqual(stale_result["result"]["status"], STATUS_DISCONNECTED)
        # ...and so does the service state: no connected overwrite happened.
        snap = service.snapshot()
        self.assertEqual(snap["status"], STATUS_DISCONNECTED)
        self.assertEqual(snap["found_ids"], [])
        self.assertEqual(snap["missing_ids"], [])

    def test_new_scan_after_disconnect_connects_normally(self):
        # Race case 4: after the disconnect + discarded stale scan, a fresh
        # scan works normally and reaches 'connected' again.
        gate = threading.Event()
        scanner = FakeScanner(gate=gate)
        service = ScanService(scanner, "can0")

        thread = threading.Thread(target=service.run_scan)
        thread.start()
        try:
            self._wait_for_scanning(service)
            service.disconnect()
        finally:
            gate.set()
            thread.join(timeout=5)
        self.assertEqual(service.snapshot()["status"], STATUS_DISCONNECTED)

        result = service.run_scan()
        self.assertEqual(result["status"], STATUS_CONNECTED)
        self.assertEqual(service.snapshot()["status"], STATUS_CONNECTED)

    def test_concurrent_scan_still_rejected_while_stale_scan_runs(self):
        # The 409 mutex behavior survives the disconnect race: while the
        # stale scan still holds the scan lock, new scans are rejected.
        gate = threading.Event()
        scanner = FakeScanner(gate=gate)
        service = ScanService(scanner, "can0")

        thread = threading.Thread(target=service.run_scan)
        thread.start()
        try:
            self._wait_for_scanning(service)
            service.disconnect()
            with self.assertRaises(ScanInProgressError):
                service.run_scan()
        finally:
            gate.set()
            thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        # After the stale scan finished, scanning is possible again.
        self.assertEqual(service.run_scan()["status"], STATUS_CONNECTED)


class ServiceDisconnectTests(unittest.TestCase):
    def test_disconnect_clears_state_and_releases_scanner(self):
        scanner = FakeScanner()
        service = ScanService(scanner, "can0")
        service.run_scan()
        self.assertEqual(service.snapshot()["status"], STATUS_CONNECTED)

        cleared = service.disconnect()
        self.assertEqual(cleared["status"], STATUS_DISCONNECTED)
        self.assertEqual(cleared["found_ids"], [])
        self.assertEqual(cleared["missing_ids"], [])
        self.assertIsNone(cleared["started_at"])
        self.assertIsNone(cleared["completed_at"])
        self.assertIsNone(cleared["source"])
        self.assertEqual(scanner.release_calls, 1)

    def test_disconnect_is_idempotent(self):
        service = ScanService(FakeScanner(), "can0")
        service.disconnect()
        cleared = service.disconnect()
        self.assertEqual(cleared["status"], STATUS_DISCONNECTED)

    def test_disconnect_release_failure_is_swallowed(self):
        class ExplodingReleaseScanner(FakeScanner):
            def release(self):
                raise OSError("release failed")

        service = ScanService(ExplodingReleaseScanner(), "can0")
        cleared = service.disconnect()  # must not raise
        self.assertEqual(cleared["status"], STATUS_DISCONNECTED)


if __name__ == "__main__":
    unittest.main()
