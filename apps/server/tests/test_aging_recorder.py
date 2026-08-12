from __future__ import annotations

import csv
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from rebot_server.aging_logs import AgingLogStore
from rebot_server.aging_recorder import AgingRecorder


def frame(sequence: int = 1) -> dict:
    return {
        "timestamp": "2026-08-12T00:00:00+00:00",
        "sequence": sequence,
        "channel": "can0",
        "source": "motorbridge",
        "joints": [
            {
                "id": motor_id,
                "position": motor_id / 10,
                "velocity": 0.01,
                "torque": 0.2,
                "temperature": {"mos": 30.0 + motor_id, "rotor": 29.0},
                "status_code": 0,
                "freshness": "fresh",
            }
            for motor_id in range(1, 8)
        ],
    }


class AgingRecorderTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="rebot-aging-recorder-"))
        self.recorder = AgingRecorder(
            AgingLogStore(self.root, min_free_bytes=0, segment_seconds=300)
        )

    def tearDown(self):
        self.recorder.shutdown()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_inactive_frames_never_create_files(self):
        self.recorder.accept_frame(frame())
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(self.recorder.status()["frames_written"], 0)

    def test_active_session_writes_exact_existing_frame_as_seven_rows(self):
        started = self.recorder.start({"operator_note": "test"})
        self.assertEqual(started["status"], "recording")
        self.recorder.accept_frame(frame())
        deadline = time.monotonic() + 2
        while self.recorder.status()["frames_written"] < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        stopped = self.recorder.stop()
        self.assertEqual(stopped["status"], "inactive")
        self.assertEqual(stopped["frames_written"], 1)
        self.assertEqual(stopped["rows_written"], 7)
        session = self.root / started["session_path"]
        csv_files = list(session.glob("telemetry_*.csv"))
        self.assertEqual(len(csv_files), 1)
        with csv_files[0].open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual([int(row["motor_id"]) for row in rows], list(range(1, 8)))
        self.assertEqual({row["timestamp"] for row in rows}, {frame()["timestamp"]})
        self.assertEqual({int(row["sequence"]) for row in rows}, {1})
        self.assertEqual({row["channel"] for row in rows}, {"can0"})
        self.assertEqual({row["source"] for row in rows}, {"motorbridge"})
        self.assertEqual({row["freshness"] for row in rows}, {"fresh"})
        self.assertEqual(float(rows[0]["temperature_mos"]), 31.0)
        self.assertEqual(float(rows[0]["temperature_rotor"]), 29.0)

        # Frames continue to exist for monitoring/trends after aging stops,
        # but the recorder must ignore them and never reopen the CSV.
        self.recorder.accept_frame(frame(sequence=2))
        time.sleep(0.05)
        self.assertEqual(self.recorder.status()["frames_written"], 1)
        with csv_files[0].open(encoding="utf-8", newline="") as handle:
            self.assertEqual(len(list(csv.DictReader(handle))), 7)

    def test_second_start_is_rejected(self):
        self.recorder.start()
        with self.assertRaises(Exception):
            self.recorder.start()


if __name__ == "__main__":
    unittest.main()
