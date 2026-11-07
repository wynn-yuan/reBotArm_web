from __future__ import annotations

import time
import unittest
import sys
import types
from types import SimpleNamespace

from rebot_server.aging_runtime import (
    AgingCommunicationLost,
    AgingRuntime,
    AgingRuntimeUnavailable,
)
from rebot_server.scanners.motorbridge import MotorbridgeCanScanner, sdk_supports_aging_motion


def frame(source="motorbridge", position=0.0):
    return {
        "timestamp": "2026-08-12T00:00:00+00:00",
        "sequence": 1,
        "channel": "can1",
        "source": source,
        "units": {"position": "rad"},
        "joints": [
            {
                "id": motor_id,
                "position": position,
                "velocity": 0.0,
                "torque": 0.0,
                "temperature": {"mos": 30.0, "rotor": 28.0},
                "status_code": 0,
                "freshness": "fresh",
            }
            for motor_id in range(1, 8)
        ],
    }


def action(samples=2):
    return {
        "id": "processed-1",
        "name": "test",
        "version": "processed",
        "samplingHz": 100,
        "jointCount": 7,
        "trails": [[0.0] * samples for _ in range(7)],
        "processing": {
            "maxJointVelocity": [1.0] * 7,
            "maxProgressSpeed": 1.0,
            "maxAcceleration": 1.0,
            "outputFrequency": 50,
        },
    }


class FakeRecorder:
    available = True

    def __init__(self):
        self.state = "inactive"
        self.started = None
        self.processed = None
        self.frames = 0
        self.events = []

    def start(self, metadata=None, *, processed_action=None):
        self.state = "recording"
        self.started = metadata
        self.processed = processed_action
        return self.status()

    def accept_frame(self, _frame):
        if self.state == "recording":
            self.frames += 1

    def append_event(self, event):
        self.events.append(dict(event))

    def stop(self):
        self.state = "inactive"
        return self.status()

    def status(self):
        return {
            "status": self.state,
            "session_path": "session-1" if self.started else None,
            "frames_written": self.frames,
            "rows_written": self.frames * 7,
            "root": "/tmp/log",
            "error": None,
        }


class FakeService:
    def __init__(self):
        self.begun = 0
        self.sent = []
        self.finished = []

    def begin_aging_motion(self):
        self.begun += 1

    def send_aging_positions(self, positions, velocity_limits, gravity_torque=None):
        self.sent.append((list(positions), list(velocity_limits)))

    def finish_aging_motion(self, *, disable):
        self.finished.append(disable)


def settings(adapter="motorbridge"):
    return SimpleNamespace(
        adapter=adapter,
        allow_aging_write=True,
        allow_active_report_write=True,
    )


class AgingRuntimeTests(unittest.TestCase):
    def wait_terminal(self, runtime, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = runtime.status()
            if status["status"] not in {"starting", "running", "stopping"}:
                return status
            time.sleep(0.01)
        self.fail(f"aging runtime did not stop: {runtime.status()}")

    def test_count_cycle_starts_motion_and_recording_together(self):
        recorder = FakeRecorder()
        service = FakeService()
        runtime = AgingRuntime(settings(), service, recorder)
        runtime.accept_frame(frame())

        started = runtime.start(
            action(),
            {"loop_mode": "count", "loop_count": 1, "interval_sec": 0},
        )
        self.assertIn(started["status"], {"running", "completed"})
        ended = self.wait_terminal(runtime)

        self.assertEqual(ended["status"], "completed")
        self.assertEqual(ended["completed_rounds"], 1)
        self.assertEqual(service.begun, 1)
        self.assertEqual(len(service.sent), 2)
        self.assertEqual(service.finished, [True])
        self.assertEqual(recorder.started["kind"], "aging_cycle")
        self.assertEqual(recorder.processed["id"], "processed-1")
        self.assertEqual(recorder.state, "inactive")

        # 会话起止时间：终态 stopped 事件必须带校正后的墙钟起止时间，status 也有 ended_at。
        terminal = recorder.events[-1]
        self.assertEqual(terminal["type"], "stopped")
        self.assertEqual(terminal["status"], "completed")
        self.assertRegex(terminal["at"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(terminal["started_at"], started["started_at"])
        self.assertEqual(terminal["ended_at"], ended["ended_at"])
        self.assertIsNotNone(ended["ended_at"])

    def test_simulation_frames_cannot_start_real_aging(self):
        runtime = AgingRuntime(settings(), FakeService(), FakeRecorder())
        runtime.accept_frame(frame(source="simulation"))
        with self.assertRaisesRegex(Exception, "motorbridge"):
            runtime.start(
                action(),
                {"loop_mode": "count", "loop_count": 1, "interval_sec": 0},
            )

    def test_temp_limit_validation_rejects_invalid(self):
        runtime = AgingRuntime(settings(), FakeService(), FakeRecorder())
        runtime.accept_frame(frame())
        for bad in (0, -1, 200.5, "hot"):
            with self.assertRaisesRegex(Exception, "temp_limit_c", msg=str(bad)):
                runtime.start(
                    action(),
                    {"loop_mode": "count", "loop_count": 1, "interval_sec": 0, "temp_limit_c": bad},
                )

    def test_temp_protection_stops_and_writes_event(self):
        recorder = FakeRecorder()
        service = FakeService()
        runtime = AgingRuntime(settings(), service, recorder)
        # frame() reports mos temperature 30.0 °C on every joint.
        runtime.accept_frame(frame())

        started = runtime.start(
            action(),
            {"loop_mode": "count", "loop_count": 1, "interval_sec": 0, "temp_limit_c": 25},
        )
        self.assertEqual(started["temp_limit_c"], 25.0)
        ended = self.wait_terminal(runtime)

        self.assertEqual(ended["status"], "completed")
        self.assertEqual(ended["completed_rounds"], 0)
        protection = ended["temp_protection"]
        self.assertIsNotNone(protection)
        self.assertEqual(protection["joint"], 1)
        self.assertEqual(protection["temperature_c"], 30.0)
        self.assertEqual(protection["limit_c"], 25.0)
        # The session event was appended for audit.
        self.assertEqual(recorder.events[0]["type"], "safety_temp_exceeded")
        self.assertEqual(recorder.events[0]["joint_id"], 1)
        self.assertEqual(recorder.events[0]["temperature_c"], 30.0)

    def test_check_temperature_within_limit_returns_none(self):
        runtime = AgingRuntime(settings(), FakeService(), FakeRecorder())
        runtime.accept_frame(frame())  # mos = 30.0
        runtime._temp_limit_c = 40.0
        self.assertIsNone(runtime._check_temperature())

    def test_backend_rejects_trajectory_outside_joint_limits(self):
        invalid = action()
        invalid["trails"][3] = [0.0, 2.0]
        runtime = AgingRuntime(settings(), FakeService(), FakeRecorder())
        runtime.accept_frame(frame())
        with self.assertRaisesRegex(Exception, "position limit"):
            runtime.start(
                invalid,
                {"loop_mode": "count", "loop_count": 1, "interval_sec": 0},
            )


class AgingStatusVendorTests(unittest.TestCase):
    """status_code 语义随机型厂商变化，健康判定必须按厂商区分。"""

    @staticmethod
    def _arm(vendor, joint_count=6, gripper=False):
        motors = [SimpleNamespace(id=i, vendor=vendor) for i in range(1, joint_count + 1)]
        gripper_spec = (
            SimpleNamespace(id=joint_count + 1, vendor=vendor) if gripper else None
        )
        return SimpleNamespace(
            motor_ids=tuple(range(1, joint_count + 1)),
            joint_count=joint_count,
            joint_limits=((-3.0, 3.0),) * joint_count,
            joint_ids=tuple(range(1, joint_count + 1 + (1 if gripper else 0))),
            joint_positions=((-3.0, 3.0),) * (joint_count + (1 if gripper else 0)),
            motors=motors,
            gripper=gripper_spec,
        )

    @staticmethod
    def _frame(joint_count=6, status_code=0):
        sample = frame()
        sample["joints"] = sample["joints"][:joint_count]
        for joint in sample["joints"]:
            joint["status_code"] = status_code
        return sample

    def _runtime(self, vendor):
        base = settings()
        base.arm = self._arm(vendor)
        return AgingRuntime(base, FakeService(), FakeRecorder())

    def test_damiao_enabled_status_is_healthy(self):
        runtime = self._runtime("damiao")
        runtime.accept_frame(self._frame(status_code=1))
        positions = runtime._fresh_positions(check_status=True)
        self.assertEqual(len(positions), 6)

    def test_damiao_fault_status_is_rejected(self):
        runtime = self._runtime("damiao")
        runtime.accept_frame(self._frame(status_code=8))
        with self.assertRaisesRegex(Exception, "joint 1 status code 8"):
            runtime._fresh_positions(check_status=True)

    def test_robstride_nonzero_status_is_rejected(self):
        runtime = self._runtime("robstride")
        runtime.accept_frame(self._frame(status_code=1))
        with self.assertRaisesRegex(Exception, "joint 1 status code 1"):
            runtime._fresh_positions(check_status=True)


class AgingSixAxisTests(unittest.TestCase):
    """老化只驱动 6 个转动关节；带夹爪机型的旧 7 轴动作/遥测仍可用。"""

    def _runtime(self):
        base = settings()
        base.arm = AgingStatusVendorTests._arm("robstride", gripper=True)
        return AgingRuntime(base, FakeService(), FakeRecorder())

    def test_gripper_is_excluded_from_aging_joints(self):
        runtime = self._runtime()
        self.assertEqual(runtime._joint_count, 6)
        self.assertEqual(runtime._expected_ids, (1, 2, 3, 4, 5, 6))

    def test_full_chain_frame_is_accepted(self):
        runtime = self._runtime()
        runtime.accept_frame(AgingStatusVendorTests._frame(joint_count=7))
        self.assertEqual(len(runtime._fresh_positions(check_status=True)), 6)

    def test_seven_trail_action_is_truncated_to_six_joints(self):
        runtime = self._runtime()
        runtime.accept_frame(AgingStatusVendorTests._frame(joint_count=7))
        normalized, _ = runtime._validate(
            action(), {"loop_mode": "count", "loop_count": 1, "interval_sec": 0}
        )
        self.assertTrue(all(len(sample) == 6 for sample in normalized["samples"]))
        self.assertEqual(len(normalized["velocity_limits"]), 6)

    def test_six_trail_action_is_accepted(self):
        runtime = self._runtime()
        runtime.accept_frame(AgingStatusVendorTests._frame(joint_count=7))
        six = action()
        six["trails"] = six["trails"][:6]
        six["jointCount"] = 6
        six["processing"]["maxJointVelocity"] = six["processing"]["maxJointVelocity"][:6]
        normalized, _ = runtime._validate(
            six, {"loop_mode": "count", "loop_count": 1, "interval_sec": 0}
        )
        self.assertTrue(all(len(sample) == 6 for sample in normalized["samples"]))


class AgingRewaitTelemetryTests(unittest.TestCase):
    """Telemetry resumes after the zero-torque->enable transition."""

    def test_fresh_positions_requires_real_telemetry(self):
        runtime = AgingRuntime(settings(), FakeService(), FakeRecorder())
        with self.assertRaises(AgingCommunicationLost):
            runtime._fresh_positions(check_status=True)

    def test_waits_for_telemetry_to_resume(self):
        runtime = AgingRuntime(settings(), FakeService(), FakeRecorder())
        runtime.accept_frame(frame())
        runtime._wait_telemetry_ready(timeout=0.5)

    def test_fails_closed_when_telemetry_never_returns(self):
        runtime = AgingRuntime(settings(), FakeService(), FakeRecorder())
        with self.assertRaises(AgingCommunicationLost):
            runtime._wait_telemetry_ready(timeout=0.1)


class AgingScannerSurfaceTests(unittest.TestCase):
    def test_shared_scanner_uses_mit_for_all_seven_motors(self):
        calls = []

        class Controller:
            def enable_all(self):
                pass

            def disable_all(self):
                pass

        class Motor:
            def __init__(self, motor_id):
                self.motor_id = motor_id

            def ensure_mode(self, mode, timeout_ms):
                calls.append(("mode", self.motor_id, mode, timeout_ms))

            def robstride_get_param_i8(self, param, timeout_ms):
                calls.append(("read_mode", self.motor_id, param, timeout_ms))
                return 0  # run_mode 0 == MIT

            def send_mit(self, pos, vel, kp, kd, tau):
                calls.append(("send", self.motor_id, pos, vel, kp, kd, tau))

        module = types.ModuleType("fake_aging_motorbridge")
        module.Controller = Controller
        module.Motor = Motor
        module.Mode = SimpleNamespace(MIT="mit")
        module.core = module
        sys.modules[module.__name__] = module
        try:
            scanner = MotorbridgeCanScanner(module_name=module.__name__, persist=True)
            scanner._controller = Controller()
            scanner._motors = {motor_id: Motor(motor_id) for motor_id in range(1, 8)}
            scanner.ensure_mit_mode()
            scanner.send_aging_mit([0.1] * 7)
        finally:
            sys.modules.pop(module.__name__, None)

        self.assertTrue(sdk_supports_aging_motion(module))
        # ensure_mode is repeated 3x per motor (reference flow), then run_mode
        # (0x7005) is confirmed == 0 before the arm is considered ready.
        self.assertEqual(
            [call for call in calls if call[0] == "mode"],
            [("mode", motor_id, "mit", 1000) for motor_id in range(1, 8) for _ in range(3)],
        )
        self.assertEqual(
            [call for call in calls if call[0] == "read_mode"],
            [("read_mode", motor_id, 0x7005, 500) for motor_id in range(1, 8)],
        )
        # MIT position servo: vel=0, kp/kd from config, tau=0.
        self.assertEqual(
            [call for call in calls if call[0] == "send"],
            [
                ("send", motor_id, 0.1, 0.0, scanner._mit_kp[index], scanner._mit_kd[index], 0.0)
                for index, motor_id in enumerate(range(1, 8))
            ],
        )

    def test_aging_mit_skips_gripper_and_maps_gains_by_id(self):
        """带夹爪机型：老化只给 6 个转动关节发 MIT，夹爪不动作。"""
        calls = []

        class Controller:
            def enable_all(self):
                pass

            def disable_all(self):
                pass

        class Motor:
            def __init__(self, motor_id):
                self.motor_id = motor_id

            def send_mit(self, pos, vel, kp, kd, tau):
                calls.append((self.motor_id, pos, kp, kd))

        arm = SimpleNamespace(motor_ids=(1, 2, 3, 4, 5, 6), joint_ids=(1, 2, 3, 4, 5, 6, 7))
        scanner = MotorbridgeCanScanner(
            arm=arm,
            mit_kp=[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 9.9],
            mit_kd=[1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.8],
        )
        scanner._controller = Controller()
        scanner._motors = {motor_id: Motor(motor_id) for motor_id in range(1, 8)}
        with self.assertRaisesRegex(ValueError, "6 positions"):
            scanner.send_aging_mit([0.1] * 7)
        scanner.send_aging_mit([0.1] * 6)
        self.assertEqual([call[0] for call in calls], [1, 2, 3, 4, 5, 6])
        self.assertEqual([call[2] for call in calls], [0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
        self.assertEqual([call[3] for call in calls], [1.1, 1.2, 1.3, 1.4, 1.5, 1.6])

    def test_simulation_adapter_never_reports_aging_available(self):
        runtime = AgingRuntime(settings(adapter="simulation"), FakeService(), FakeRecorder())
        runtime.accept_frame(frame())
        self.assertFalse(runtime.available)
        with self.assertRaises(AgingRuntimeUnavailable):
            runtime.start(
                action(),
                {"loop_mode": "count", "loop_count": 1, "interval_sec": 0},
            )


if __name__ == "__main__":
    unittest.main()
