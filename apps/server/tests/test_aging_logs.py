"""Security and persistence tests for the file-only aging-log capability."""

from __future__ import annotations

import csv
import json
import os
import shutil
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from rebot_server.aging_logs import (
    AgingLogDiskSpaceError,
    AgingLogDisabledError,
    AgingLogPathError,
    AgingLogPermissionError,
    AgingLogStore,
    AgingLogStorageError,
    TELEMETRY_FIELDS,
)
from rebot_server.config import ConfigError, Settings, load_settings


class AgingLogStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rebot-aging-test-"))
        self.store = AgingLogStore(self.tmp, min_free_bytes=0, segment_seconds=60)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_root_disables_capability(self):
        store = AgingLogStore("")
        self.assertFalse(store.enabled)
        with self.assertRaises(AgingLogDisabledError):
            store.create_session()

    def test_relative_path_validation_rejects_escape_forms(self):
        invalid = (
            "../escape",
            "a/../../escape",
            "a/../b",
            "/tmp/escape",
            "C:/escape",
            "C:\\escape",
            "a\\b",
            "a//b",
            "a/./b",
            "",
        )
        for path in invalid[:-1]:
            with self.assertRaises(AgingLogPathError, msg=path):
                self.store.create_directory(path)
        self.assertEqual(self.store.create_directory(""), "")

    def test_symlink_escape_is_rejected(self):
        outside = Path(tempfile.mkdtemp(prefix="rebot-aging-outside-"))
        link = self.tmp / "link"
        try:
            try:
                link.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable")
            with self.assertRaises(AgingLogPathError):
                self.store.create_directory("link/escape")
            with self.assertRaises(AgingLogPathError):
                self.store.list_directories("link")
            self.assertFalse((outside / "escape").exists())
        finally:
            link.unlink(missing_ok=True)
            shutil.rmtree(outside, ignore_errors=True)

    def test_session_structure_and_event_flush(self):
        info = self.store.create_session(
            "runs/2026",
            session={"operator": "test"},
            raw_action={"kind": "raw"},
            processed_action={"kind": "processed"},
        )
        session_dir = self.tmp / info.relative_path
        self.assertTrue(session_dir.is_dir())
        self.assertEqual(
            {path.name for path in session_dir.iterdir()},
            {"session.json", "raw_action.json", "processed_action.json", "events.jsonl"},
        )
        manifest = json.loads((session_dir / "session.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["operator"], "test")
        self.assertFalse(manifest["execution_available"])
        self.store.append_event(info.relative_path, {"type": "created", "ok": True})
        event_lines = (session_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(json.loads(event_lines[0])["type"], "created")
        self.store.write_session_json(info.relative_path, "raw_action.json", {"updated": True})
        self.assertEqual(
            json.loads((session_dir / "raw_action.json").read_text(encoding="utf-8")),
            {"updated": True},
        )
        self.assertEqual(list(session_dir.glob(".*.tmp")), [])

    def test_concurrent_session_creation_is_unique(self):
        def create_one(_):
            return self.store.create_session("parallel").session_id

        with ThreadPoolExecutor(max_workers=12) as pool:
            ids = list(pool.map(create_one, range(48)))
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(list((self.tmp / "parallel").iterdir())), 48)

    def test_disk_and_permission_failures_happen_before_session_creation(self):
        with patch(
            "rebot_server.aging_logs.shutil.disk_usage",
            return_value=SimpleNamespace(free=0),
        ):
            self.store.min_free_bytes = 1
            with self.assertRaises(AgingLogDiskSpaceError):
                self.store.create_session()
        self.assertEqual(list(self.tmp.iterdir()), [])
        with patch("rebot_server.aging_logs.os.access", return_value=False):
            with self.assertRaises(AgingLogPermissionError):
                self.store.create_session()
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_failed_initialization_cleans_only_the_new_session(self):
        with patch.object(
            AgingLogStore,
            "_atomic_json",
            side_effect=AgingLogStorageError("injected write failure"),
        ):
            with self.assertRaises(AgingLogStorageError):
                self.store.create_session("kept")
        kept = self.tmp / "kept"
        self.assertTrue(kept.is_dir())
        self.assertEqual(list(kept.iterdir()), [])
        self.assertEqual(list(self.tmp.glob("*")), [kept])

    def test_telemetry_schema_segmentation_and_close_idempotence(self):
        info = self.store.create_session()
        writer = self.store.telemetry_writer(info.relative_path)
        row = {
            "timestamp": "2026-08-11T00:00:00+00:00",
            "motor_id": 1,
            "position": 1.0,
            "velocity": 2.0,
            "torque": 3.0,
            "temperature_mos": 32.0,
            "temperature_rotor": 31.0,
            "status_code": 0,
        }
        writer.append(row, now=1000)
        writer.append(row, now=1001)
        writer.append(row, now=1061)
        writer.close()
        writer.close()
        files = sorted((self.tmp / info.relative_path).glob("telemetry_*.csv"))
        self.assertEqual(len(files), 2)
        for file in files:
            with file.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.reader(handle))
            self.assertEqual(rows[0], list(TELEMETRY_FIELDS))
            self.assertGreaterEqual(len(rows), 2)
        with self.assertRaises(AgingLogStorageError):
            writer.append(row, now=1100)
        with self.assertRaises(AgingLogStorageError):
            self.store.telemetry_writer(info.relative_path).append(
                {**row, "unknown": 1}
            )


class AgingLogConfigTests(unittest.TestCase):
    def test_defaults_are_disabled_and_bounded(self):
        settings = load_settings(env={})
        self.assertEqual(settings.aging_log_root, "")
        self.assertEqual(settings.aging_log_min_free_bytes, 100 * 1024 * 1024)
        self.assertEqual(settings.aging_log_segment_seconds, 300)

    def test_log_configuration_is_parsed_and_rejects_unsafe_values(self):
        configured_root = str(Path(tempfile.gettempdir()) / "rebotarm-logs")
        settings = load_settings(
            env={
                "REBOT_AGING_LOG_ROOT": configured_root,
                "REBOT_AGING_LOG_MIN_FREE_BYTES": "4096",
                "REBOT_AGING_LOG_SEGMENT_SECONDS": "60",
            }
        )
        self.assertEqual(settings.aging_log_root, configured_root)
        self.assertEqual(settings.aging_log_min_free_bytes, 4096)
        self.assertEqual(settings.aging_log_segment_seconds, 60)
        for env in (
            {"REBOT_AGING_LOG_ROOT": "relative/root"},
            {"REBOT_AGING_LOG_MIN_FREE_BYTES": "-1"},
            {"REBOT_AGING_LOG_MIN_FREE_BYTES": "nope"},
            {"REBOT_AGING_LOG_SEGMENT_SECONDS": "0"},
            {"REBOT_AGING_LOG_SEGMENT_SECONDS": "999999"},
        ):
            with self.assertRaises(ConfigError):
                load_settings(env=env)


@unittest.skipUnless(os.name == "nt" or os.name == "posix", "filesystem tests")
class AgingLogApiTests(unittest.TestCase):
    def test_api_manages_files_but_does_not_open_execution(self):
        try:
            from fastapi.testclient import TestClient
            from rebot_server.app import create_app
        except Exception as exc:  # pragma: no cover - dependency guard
            self.skipTest(str(exc))
        tmp = Path(tempfile.mkdtemp(prefix="rebot-aging-api-"))
        try:
            app = create_app(
                settings=Settings(
                    aging_log_root=str(tmp),
                    aging_log_min_free_bytes=0,
                    aging_log_segment_seconds=60,
                )
            )
            with TestClient(app) as client:
                status = client.get("/api/aging/logs")
                self.assertEqual(status.status_code, 200)
                self.assertFalse(status.json()["aging_execution_available"])
                self.assertTrue(status.json()["aging_recording_available"])
                self.assertEqual(client.get("/api/aging/status").json()["status"], "inactive")
                self.assertEqual(
                    client.post("/api/aging/start", json={"confirm": False}).status_code,
                    400,
                )
                self.assertEqual(client.post("/api/robot/scan").status_code, 200)
                # Simulation can exercise UI/scan tests but must never create
                # an aging telemetry recording that could be mistaken for real data.
                self.assertEqual(
                    client.post("/api/aging/start", json={"confirm": True}).status_code,
                    409,
                )
                self.assertEqual(
                    client.post("/api/aging/logs/directories", json={"path": "runs"}).status_code,
                    200,
                )
                bad = client.post(
                    "/api/aging/logs/directories", json={"path": "../escape"}
                )
                self.assertEqual(bad.status_code, 400)
                created = client.post(
                    "/api/aging/logs/sessions",
                    json={"directory": "runs", "raw_action": {"a": 1}},
                )
                self.assertEqual(created.status_code, 200)
                self.assertFalse(created.json()["aging_execution_available"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
