"""Backend Trajectory action-library tests: storage safety and HTTP routes.

These cover the persistence layer (AgingLogStore) and the /api/aging/actions
routes plus the by-id aging start path. No CAN hardware is involved; the
storage tests are stdlib-only and the route tests use FastAPI TestClient with
the simulation adapter and temporary roots.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from rebot_server.aging_logs import (
    AgingLogDisabledError,
    AgingLogPathError,
    AgingLogSessionError,
    AgingLogStore,
)

try:
    import httpx  # noqa: F401  (required by TestClient)
    from fastapi.testclient import TestClient

    from rebot_server.app import create_app
    from rebot_server.config import Settings

    _DEPS_AVAILABLE = True
except Exception:  # ImportError or broken install
    _DEPS_AVAILABLE = False


def make_processed_action(action_id: str = "processed-1700000000-abc123") -> dict:
    """A valid processed action the aging runtime will accept (all-zero home)."""
    # 50 samples at 50 Hz = 1 s. All-zero positions keep every joint in limits
    # and every inter-sample velocity at zero.
    trail = [0.0] * 50
    return {
        "id": action_id,
        "name": "测试动作",
        "version": "processed",
        "createdAt": 1700000000000,
        "durationMs": 1000,
        "sampleCount": 50,
        "samplingHz": 50,
        "jointCount": 7,
        "rawActionId": "raw-abc",
        "trails": [list(trail) for _ in range(7)],
        "processing": {
            "maxJointVelocity": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
            "maxProgressSpeed": 0.8,
            "maxAcceleration": 1.5,
            "outputFrequency": 50,
        },
    }


class ActionLibraryStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rebot-action-test-"))
        self.log_root = self.tmp / "aging"
        self.traj_root = self.tmp / "Trajectory"
        self.store = AgingLogStore(
            self.log_root,
            min_free_bytes=0,
            segment_seconds=60,
            trajectory_root=str(self.traj_root),
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_trajectory_root_disables_action_library(self):
        store = AgingLogStore("", trajectory_root="")
        self.assertFalse(store.trajectory_enabled)
        with self.assertRaises(AgingLogDisabledError):
            store.save_action(make_processed_action())
        with self.assertRaises(AgingLogDisabledError):
            store.list_actions()

    def test_save_list_delete_roundtrip(self):
        action = make_processed_action()
        self.assertEqual(self.store.save_action(action), action)
        listed = self.store.list_actions()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], action["id"])
        self.assertEqual(listed[0]["trails"], action["trails"])
        self.store.delete_action(action["id"])
        self.assertEqual(self.store.list_actions(), [])

    def test_save_is_keyed_by_id(self):
        first = make_processed_action("processed-111")
        second = make_processed_action("processed-222")
        self.store.save_action(first)
        self.store.save_action(second)
        ids = {item["id"] for item in self.store.list_actions()}
        self.assertEqual(ids, {"processed-111", "processed-222"})

    def test_save_overwrites_same_id(self):
        action = make_processed_action()
        self.store.save_action(action)
        updated = dict(action)
        updated["name"] = "覆盖后"
        self.store.save_action(updated)
        listed = self.store.list_actions()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["name"], "覆盖后")

    def test_delete_missing_raises_session_error(self):
        with self.assertRaises(AgingLogSessionError):
            self.store.delete_action("processed-missing")

    def test_invalid_action_id_rejected(self):
        for bad in ("../escape", "a/b", "", "a\\b", "..", ".", "a b"):
            with self.assertRaises(AgingLogPathError, msg=bad):
                self.store.save_action({**make_processed_action(), "id": bad})

    def test_get_action_roundtrip(self):
        action = make_processed_action()
        self.store.save_action(action)
        loaded = self.store.get_action(action["id"])
        self.assertEqual(loaded["trails"], action["trails"])
        self.assertEqual(loaded["processing"]["maxJointVelocity"], [0.5] * 7)

    def test_get_action_missing_raises_session_error(self):
        with self.assertRaises(AgingLogSessionError):
            self.store.get_action("processed-missing")

    def test_actions_live_in_trajectory_root(self):
        self.store.save_action(make_processed_action())
        self.assertTrue((self.traj_root / "processed-1700000000-abc123.json").is_file())
        # The aging-log root is untouched by the action library.
        self.assertFalse((self.log_root / "processed-1700000000-abc123.json").exists())

    def test_symlink_stored_file_is_rejected(self):
        outside = Path(tempfile.mkdtemp(prefix="rebot-action-outside-"))
        outside_file = outside / "target.json"
        outside_file.write_text("{}", encoding="utf-8")
        action = make_processed_action()
        directory = self.traj_root
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{action['id']}.json"
        try:
            try:
                target.symlink_to(outside_file)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable")
            with self.assertRaises(AgingLogPathError):
                self.store.save_action(action)
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_corrupt_file_is_skipped_not_fatal(self):
        self.store.save_action(make_processed_action())
        (self.traj_root / "processed-corrupt.json").write_text("{not json", encoding="utf-8")
        listed = self.store.list_actions()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], "processed-1700000000-abc123")


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class ActionLibraryApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rebot-action-api-"))
        app = create_app(
            settings=Settings(
                aging_log_root=str(self.tmp / "aging"),
                trajectory_dir=str(self.tmp / "Trajectory"),
            )
        )
        self.client = TestClient(app)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_list_empty(self):
        response = self.client.get("/api/aging/actions")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["actions"], [])

    def test_save_and_list(self):
        action = make_processed_action()
        post = self.client.post("/api/aging/actions", json={"action": action})
        self.assertEqual(post.status_code, 200, post.text)
        self.assertEqual(post.json()["action"]["id"], action["id"])

        listed = self.client.get("/api/aging/actions").json()["actions"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["trails"], action["trails"])

    def test_save_rejects_invalid_action(self):
        bad = make_processed_action()
        bad["samplingHz"] = 30  # not the required 50 Hz
        response = self.client.post("/api/aging/actions", json={"action": bad})
        self.assertEqual(response.status_code, 400)
        self.assertIn("code", response.json()["error"])
        # Nothing persisted.
        self.assertEqual(self.client.get("/api/aging/actions").json()["actions"], [])

    def test_delete(self):
        action = make_processed_action()
        self.client.post("/api/aging/actions", json={"action": action})
        delete = self.client.delete(f"/api/aging/actions/{action['id']}")
        self.assertEqual(delete.status_code, 200)
        self.assertTrue(delete.json()["deleted"])
        self.assertEqual(self.client.get("/api/aging/actions").json()["actions"], [])

    def test_delete_missing_returns_404(self):
        response = self.client.delete("/api/aging/actions/processed-nope")
        self.assertEqual(response.status_code, 404)
        self.assertIn("code", response.json()["error"])

    def test_start_by_action_id_is_gated_in_simulation(self):
        # The connection/motorbridge gates fire before action resolution, so a
        # by-id aging start is rejected fail-closed in a disconnected client
        # whether or not the action exists. This proves the action_id field is
        # accepted (no 422) and the connection gate takes priority.
        response = self.client.post(
            "/api/aging/start",
            json={"confirm": True, "action_id": "processed-nope", "config": {"loop_mode": "count", "loop_count": 1, "interval_sec": 0}},
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "aging_requires_connected")

    def test_start_resolves_action_only_after_gates_pass(self):
        # A stored action resolves only after the connection/adapter gates
        # pass; in a disconnected client those gates reject first (fail closed).
        action = make_processed_action()
        self.client.post("/api/aging/actions", json={"action": action})
        response = self.client.post(
            "/api/aging/start",
            json={"confirm": True, "action_id": action["id"], "config": {"loop_mode": "count", "loop_count": 1, "interval_sec": 0}},
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "aging_requires_connected")


if __name__ == "__main__":
    unittest.main()