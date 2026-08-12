"""Tests for the read-only telemetry building blocks.

Simulation mode streams deterministic frames over ``/ws/robot/telemetry``;
the motorbridge active-report session (the ONLY authorized motor write,
gated behind ``REBOT_ALLOW_ACTIVE_REPORT_WRITE``) is tested separately in
``tests/test_activereport.py``. No hardware is touched.
"""

from __future__ import annotations

import asyncio
import time
import types
import unittest

from rebot_server.config import Settings
from rebot_server.models import EXPECTED_MOTOR_IDS
from rebot_server.telemetry import (
    UNITS,
    build_simulation_frame,
    joint_from_motor_state,
    put_latest,
    stream_simulation_telemetry,
)

try:
    import httpx  # noqa: F401  (required by TestClient)
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    from rebot_server.app import create_app

    _DEPS_AVAILABLE = True
except Exception:  # ImportError or broken install
    _DEPS_AVAILABLE = False


class SimulationFrameTests(unittest.TestCase):
    """The frame builder is pure and deterministic (stdlib-only)."""

    def test_frame_is_deterministic_except_timestamp(self):
        frame_a = build_simulation_frame(
            42, "can0", EXPECTED_MOTOR_IDS, EXPECTED_MOTOR_IDS
        )
        frame_b = build_simulation_frame(
            42, "can0", EXPECTED_MOTOR_IDS, EXPECTED_MOTOR_IDS
        )
        frame_a.pop("timestamp")
        frame_b.pop("timestamp")
        self.assertEqual(frame_a, frame_b)

    def test_frame_shape_and_contract_fields(self):
        frame = build_simulation_frame(
            7, "can0", EXPECTED_MOTOR_IDS, EXPECTED_MOTOR_IDS
        )
        self.assertEqual(frame["sequence"], 7)
        self.assertEqual(frame["channel"], "can0")
        self.assertEqual(frame["source"], "simulation")
        self.assertTrue(frame["timestamp"])
        # Units are explicit in every frame (confirmed from the motorbridge
        # 0.5.1 sources: rad / rad/s / Nm / °C).
        self.assertEqual(
            frame["units"],
            {
                "position": "rad",
                "velocity": "rad/s",
                "torque": "Nm",
                "temperature": "degC",
            },
        )
        self.assertEqual(frame["units"], UNITS)
        self.assertEqual(
            [j["id"] for j in frame["joints"]], list(EXPECTED_MOTOR_IDS)
        )
        for joint in frame["joints"]:
            for key in (
                "position",
                "velocity",
                "torque",
                "current",
                "temperature",
                "status_code",
                "error_code",
                "freshness",
            ):
                self.assertIn(key, joint)
            # Fields the real SDK's MotorState cannot provide are null even
            # in simulation, so the client contract is identical across modes
            # (never fabricate real-SDK capabilities).
            self.assertIsNone(joint["current"])
            self.assertIsNone(joint["error_code"])
            self.assertEqual(joint["freshness"], "fresh")
            self.assertEqual(joint["status_code"], 0)
            self.assertIsInstance(joint["position"], float)
            self.assertIsInstance(joint["velocity"], float)
            self.assertIsInstance(joint["torque"], float)
            self.assertEqual(set(joint["temperature"]), {"mos", "rotor"})
            self.assertIsInstance(joint["temperature"]["mos"], float)
            self.assertIsInstance(joint["temperature"]["rotor"], float)

    def test_absent_joints_are_null_and_never_fabricated(self):
        frame = build_simulation_frame(1, "can0", EXPECTED_MOTOR_IDS, (1, 2))
        by_id = {j["id"]: j for j in frame["joints"]}
        for present in (1, 2):
            self.assertEqual(by_id[present]["freshness"], "fresh")
            self.assertIsNotNone(by_id[present]["position"])
        for absent in (3, 4, 5, 6, 7):
            joint = by_id[absent]
            self.assertEqual(joint["freshness"], "none")
            for key in (
                "position",
                "velocity",
                "torque",
                "current",
                "status_code",
                "error_code",
            ):
                self.assertIsNone(joint[key], key)
            self.assertEqual(joint["temperature"], {"mos": None, "rotor": None})

    def test_values_vary_with_sequence(self):
        frame_a = build_simulation_frame(
            1, "can0", EXPECTED_MOTOR_IDS, EXPECTED_MOTOR_IDS
        )
        frame_b = build_simulation_frame(
            2, "can0", EXPECTED_MOTOR_IDS, EXPECTED_MOTOR_IDS
        )
        self.assertNotEqual(
            frame_a["joints"][0]["position"], frame_b["joints"][0]["position"]
        )


class LatestQueueTests(unittest.TestCase):
    """put_latest implements the bounded keep-latest policy for slow clients."""

    def test_overflow_keeps_only_the_newest_frame(self):
        async def scenario():
            queue = asyncio.Queue(maxsize=1)
            for sequence in (1, 2, 3, 4, 5):
                await put_latest(queue, {"sequence": sequence})
            self.assertEqual(queue.qsize(), 1)
            self.assertEqual(await queue.get(), {"sequence": 5})

        asyncio.run(scenario())

    def test_consumer_waits_until_a_frame_is_published(self):
        async def scenario():
            queue = asyncio.Queue(maxsize=1)
            getter = asyncio.ensure_future(queue.get())
            await asyncio.sleep(0.02)
            self.assertFalse(getter.done())
            await put_latest(queue, {"sequence": 1})
            self.assertEqual(
                await asyncio.wait_for(getter, timeout=1.0), {"sequence": 1}
            )

        asyncio.run(scenario())


class SlowConsumerPolicyTests(unittest.TestCase):
    def test_slow_consumer_drops_intermediate_frames(self):
        # The real stream loop with an async-slow fake WebSocket: the
        # producer keeps running at full rate while sends block, and the
        # bounded keep-latest queue drops intermediate frames — the client
        # jumps ahead to the newest data instead of replaying stale frames.
        # (TestClient's WS bridge is unbounded, so this must be tested at
        # the loop level.)

        class FakeService:
            def __init__(self):
                self._generation = 0

            @property
            def generation(self):
                return self._generation

            def bump(self):
                self._generation += 1

        class SlowFakeWebSocket:
            def __init__(self, service, send_delay_s=0.1, stop_after=3):
                self._service = service
                self._send_delay_s = send_delay_s
                self._stop_after = stop_after
                self.sent = []
                self.closed = []

            async def send_json(self, frame):
                self.sent.append(frame)
                if len(self.sent) >= self._stop_after:
                    self._service.bump()  # end the stream after enough sends
                await asyncio.sleep(self._send_delay_s)  # slow client

            async def receive(self):
                await asyncio.sleep(3600)  # silent client, never closes

            async def close(self, code=1000):
                self.closed.append(code)

        service = FakeService()
        websocket = SlowFakeWebSocket(service)
        settings = Settings(telemetry_hz=50.0)
        asyncio.run(stream_simulation_telemetry(websocket, service, settings))

        sequences = [frame["sequence"] for frame in websocket.sent]
        self.assertEqual(len(sequences), 3)
        self.assertEqual(websocket.closed, [1000])
        # At 50 Hz with 0.1 s per send, ~5 frames are produced per send
        # window; an unbounded FIFO would deliver consecutive sequences
        # (1, 2, 3). Keep-latest means the delivered sequences jump ahead.
        for older, newer in zip(sequences, sequences[1:]):
            self.assertGreater(newer, older)
        self.assertGreater(
            sequences[-1],
            len(sequences),
            f"expected dropped frames, got consecutive {sequences}",
        )


class SimulationStreamSendFailureTests(unittest.TestCase):
    """Phase 7G regression: a client disconnect racing an in-flight frame
    send makes ``send_json`` raise (starlette WebSocketDisconnect). The
    simulation stream must treat any send failure as a normal end of
    stream: stop, cancel producer/watcher, close best-effort — and never
    propagate the exception to the ASGI layer."""

    def test_send_failure_stops_stream_without_raising(self):
        class FakeService:
            @property
            def generation(self):
                return 0

        class SendFailWebSocket:
            def __init__(self):
                self.send_attempts = 0
                self.closed = []

            async def send_json(self, frame):
                self.send_attempts += 1
                raise RuntimeError("client disconnected mid-send")

            async def receive(self):
                await asyncio.sleep(3600)  # silent client

            async def close(self, code=1000):
                self.closed.append(code)

        websocket = SendFailWebSocket()
        settings = Settings(telemetry_hz=50.0)
        # Must return cleanly (no exception) once the first send fails.
        asyncio.run(
            stream_simulation_telemetry(websocket, FakeService(), settings)
        )
        self.assertGreaterEqual(websocket.send_attempts, 1)
        self.assertEqual(websocket.closed, [1000])


class JointFromStateTests(unittest.TestCase):
    """joint_from_motor_state maps a real SDK MotorState onto the frame
    contract — and reports null instead of fabricating anything."""

    def _state(self, **overrides):
        values = dict(
            pos=0.5,
            vel=-0.25,
            torq=1.5,
            t_mos=31.5,
            t_rotor=28.25,
            status_code=0,
        )
        values.update(overrides)
        return types.SimpleNamespace(**values)

    def test_none_state_is_all_null_and_not_fabricated(self):
        joint = joint_from_motor_state(3, None)
        self.assertEqual(joint["id"], 3)
        self.assertEqual(joint["freshness"], "none")
        for key in (
            "position",
            "velocity",
            "torque",
            "current",
            "status_code",
            "error_code",
        ):
            self.assertIsNone(joint[key], key)
        self.assertEqual(joint["temperature"], {"mos": None, "rotor": None})

    def test_full_state_maps_all_motorstate_fields(self):
        joint = joint_from_motor_state(2, self._state(status_code=7))
        self.assertEqual(joint["id"], 2)
        self.assertEqual(joint["freshness"], "fresh")
        self.assertEqual(joint["position"], 0.5)
        self.assertEqual(joint["velocity"], -0.25)
        self.assertEqual(joint["torque"], 1.5)
        self.assertEqual(joint["temperature"], {"mos": 31.5, "rotor": 28.25})
        self.assertEqual(joint["status_code"], 7)
        # Fields MotorState cannot provide are ALWAYS null — the real SDK
        # has no current field and no separate error field.
        self.assertIsNone(joint["current"])
        self.assertIsNone(joint["error_code"])
        self.assertIsInstance(joint["position"], float)
        self.assertIsInstance(joint["velocity"], float)
        self.assertIsInstance(joint["torque"], float)
        self.assertIsInstance(joint["temperature"]["mos"], float)
        self.assertIsInstance(joint["temperature"]["rotor"], float)

    def test_malformed_state_is_null_never_guessed(self):
        joint = joint_from_motor_state(1, self._state(pos="not-a-number"))
        self.assertEqual(joint["freshness"], "none")
        self.assertIsNone(joint["position"])
        self.assertIsNone(joint["velocity"])


@unittest.skipUnless(_DEPS_AVAILABLE, "fastapi/httpx not installed")
class TelemetryWebSocketTests(unittest.TestCase):
    def _sim_app(self, **overrides):
        return create_app(settings=Settings(**overrides))

    def test_simulation_stream_delivers_sequential_frames(self):
        app = self._sim_app(telemetry_hz=50.0)
        with TestClient(app) as client:
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                frames = [ws.receive_json() for _ in range(3)]
        sequences = [frame["sequence"] for frame in frames]
        # Strictly increasing (duplicates are impossible: each sequence is
        # published once), starting at or after frame 1.
        self.assertGreaterEqual(sequences[0], 1)
        for older, newer in zip(sequences, sequences[1:]):
            self.assertGreater(newer, older)
        for frame in frames:
            self.assertEqual(frame["source"], "simulation")
            self.assertEqual(frame["channel"], "can0")
            self.assertEqual(len(frame["joints"]), 7)
            self.assertTrue(frame["timestamp"])
            self.assertEqual(frame["units"], UNITS)

    def test_disconnect_generation_invalidation_stops_stream(self):
        # After POST /api/robot/disconnect (generation bump) an open
        # telemetry stream must stop and the socket must close — no stale
        # telemetry survives a disconnect.
        app = self._sim_app(telemetry_hz=50.0)
        service = app.state.service
        with TestClient(app) as client:
            with client.websocket_connect("/ws/robot/telemetry") as ws:
                ws.receive_json()
                service.disconnect()  # bumps the generation
                with self.assertRaises(WebSocketDisconnect):
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        ws.receive_json()
                    raise AssertionError("socket was not closed in time")


if __name__ == "__main__":
    unittest.main()
