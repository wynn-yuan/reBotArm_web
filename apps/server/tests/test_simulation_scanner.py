"""SimulationCanScanner tests (stdlib only, no hardware)."""

from __future__ import annotations

import unittest

from rebot_server.models import EXPECTED_MOTOR_IDS
from rebot_server.scanners.simulation import SimulationCanScanner


class SimulationScannerTests(unittest.TestCase):
    def test_default_reports_all_expected_ids(self):
        outcome = SimulationCanScanner().scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, tuple(EXPECTED_MOTOR_IDS))
        self.assertEqual(outcome.errors, {})

    def test_subset_found(self):
        outcome = SimulationCanScanner(found_ids=[1, 2, 5]).scan(
            "can0", EXPECTED_MOTOR_IDS
        )
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, (1, 2, 5))

    def test_ids_outside_expected_are_ignored(self):
        outcome = SimulationCanScanner(found_ids=[1, 99, 250]).scan(
            "can0", EXPECTED_MOTOR_IDS
        )
        self.assertEqual(outcome.found_ids, (1,))

    def test_fatal_error_mode_is_fail_closed(self):
        outcome = SimulationCanScanner(fatal_error=True).scan(
            "can0", EXPECTED_MOTOR_IDS
        )
        self.assertIsNotNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())

    def test_invalid_channel_is_fail_closed(self):
        outcome = SimulationCanScanner().scan("vcan0", EXPECTED_MOTOR_IDS)
        self.assertIsNotNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())

    def test_empty_found_ids(self):
        outcome = SimulationCanScanner(found_ids=[]).scan("can0", EXPECTED_MOTOR_IDS)
        self.assertIsNone(outcome.fatal_message)
        self.assertEqual(outcome.found_ids, ())


if __name__ == "__main__":
    unittest.main()
