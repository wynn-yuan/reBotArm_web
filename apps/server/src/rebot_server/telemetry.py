"""Read-only telemetry for ``/ws/robot/telemetry``.

Safety summary
--------------
* **Simulation mode**: deterministic synthetic frames. No CAN, no SDK
  import. This is the default.
* **Motorbridge mode**: real RobStride telemetry is implemented in
  ``activereport.py`` behind an explicit, narrow authorization: the ONLY
  motor write the server may ever make is
  ``robstride_set_active_report(True/False)`` (toggle of RobStride
  comm_type 24 status reporting), and only when
  ``REBOT_ALLOW_ACTIVE_REPORT_WRITE=1`` (default OFF). With the flag off
  the endpoint rejects connections without touching any motor.

Why active reporting is required (motorbridge 0.5.1 source audit)
-----------------------------------------------------------------
Audited against the motorbridge 0.4.9 sdist source (Python layer) and its
packaged README, then re-verified for the pinned 0.5.1 by a byte-for-byte
sdist diff (Phase 7B: the Python binding layer is unchanged between 0.4.9
and 0.5.1); the Rust/native layer source is NOT shipped in the sdist.

1. The vendor's read-only state flow ``request_feedback() ->
   poll_feedback_once() -> get_state()`` yields nothing for RobStride: the
   packaged README states verbatim that ``request_feedback()`` is a
   non-blocking no-op for RobStride motors.
2. Streaming state requires ``robstride_set_active_report(True)``, which
   toggles RobStride ``comm_type`` 24 (README: "toggles RobStride comm_type
   24 active status reporting; with active reporting on, background polling
   can update ``get_state()`` from incoming status frames"). Its only
   parameter is a boolean (``core.py``: ``robstride_set_active_report(self,
   enabled: bool) -> None``) — it cannot command motion, enable the motor,
   or change gains/zero/mode. That is why it is the single authorized write
   (Phase 5 user authorization) — see ``activereport.py`` for the gates.
3. ``Controller.poll_feedback_once()`` is a native (Rust) call; its source
   is not shipped in the sdist. It is used only AFTER active reporting is
   enabled, purely to receive the reported status frames.
4. Typed parameter reads (``robstride_get_param_*``) were rejected: the
   parameter-ID-to-physical-quantity mapping is undocumented. Guessing
   register meanings is forbidden.

Frame contract (identical shape in every mode)
----------------------------------------------
{
  "timestamp": ISO-8601 UTC,
  "sequence":  monotonically increasing frame counter,
  "channel":   "can0",
  "source":    "simulation" | "motorbridge",
  "units":     {"position": "rad", "velocity": "rad/s",
                "torque": "Nm", "temperature": "degC"},
  "joints": [                      # one entry per expected motor ID (1..7)
    {
      "id":           int,
      "position":     float | null,   # rad
      "velocity":     float | null,   # rad/s
      "torque":       float | null,   # N·m
      "current":      null,           # no MotorState field in the real SDK
      "temperature":  {"mos": float|null, "rotor": float|null},  # °C
      "status_code":  int | null,
      "error_code":   null,           # no separate field in MotorState
      "freshness":    "fresh" | "none"
    }, ...
  ]
}

Units are confirmed from the motorbridge 0.5.1 sources (see ``UNITS``).
Fields the real SDK (``MotorState``: pos/vel/torq/t_mos/t_rotor/status_code)
cannot provide are ``null`` — never fabricated. Simulation mode fills the
fields that map onto ``MotorState`` with deterministic values and keeps the
unsupported ones ``null`` so the client contract is identical across modes.
"""

from __future__ import annotations

import asyncio
import math
from typing import Any, Dict, Sequence

from .models import utc_now_iso

SOURCE_SIMULATION = "simulation"
SOURCE_MOTORBRIDGE = "motorbridge"

FRESHNESS_FRESH = "fresh"
FRESHNESS_NONE = "none"

#: Physical units of the joint fields, confirmed from the motorbridge 0.5.1
#: sources: position rad / velocity rad/s (``cli/scan.py`` prints
#: ``angle={st.pos:+.3f}rad`` and ``vel={st.vel:+.3f}rad/s``; README:
#: ``send_pos_vel(3.1416, 2.0)  # rad / rad/s``), torque Nm (``cli/scan.py``
#: prints ``torq={hit.torq:+.3f}Nm``), temperature °C (``cli/scan.py`` prints
#: ``temp={st.t_mos:.1f}C``). "degC" is the ASCII spelling of °C.
UNITS: Dict[str, str] = {
    "position": "rad",
    "velocity": "rad/s",
    "torque": "Nm",
    "temperature": "degC",
}

_JOINT_NULL: Dict[str, Any] = {
    "position": None,
    "velocity": None,
    "torque": None,
    "current": None,
    "temperature": {"mos": None, "rotor": None},
    "status_code": None,
    "error_code": None,
    "freshness": FRESHNESS_NONE,
}


def joint_from_motor_state(motor_id: int, state: Any) -> Dict[str, Any]:
    """Map one SDK ``MotorState`` onto the telemetry joint contract.

    ``state is None`` (motor silent / no status frame received yet) yields
    the all-null joint with freshness ``none`` — values are never
    fabricated. ``current`` and ``error_code`` are null in every case: the
    real SDK's ``MotorState`` (can_id, arbitration_id, status_code, pos,
    vel, torq, t_mos, t_rotor) provides neither field.
    """
    if state is None:
        return {"id": motor_id, **_JOINT_NULL}
    try:
        return {
            "id": motor_id,
            "position": float(state.pos),
            "velocity": float(state.vel),
            "torque": float(state.torq),
            "current": None,
            "temperature": {
                "mos": float(state.t_mos),
                "rotor": float(state.t_rotor),
            },
            "status_code": int(state.status_code),
            "error_code": None,
            "freshness": FRESHNESS_FRESH,
        }
    except Exception:
        # A malformed state is reported as null — never as guessed numbers.
        return {"id": motor_id, **_JOINT_NULL}


def _sim_joint_values(motor_id: int, sequence: int) -> Dict[str, Any]:
    """Deterministic joint state — a pure function of (motor_id, sequence).

    No wall-clock time and no randomness enter the *values*, so any two runs
    with the same sequence are bit-identical (only ``timestamp`` differs).
    The fields mirror what a real ``MotorState`` can provide; ``current``
    and ``error_code`` stay null because the real SDK has no such fields.
    """
    angle = sequence * 0.05 + motor_id * 0.9
    return {
        "position": round(math.sin(angle) * 1.5, 6),
        "velocity": round(math.cos(angle) * 0.075, 6),
        "torque": round(math.sin(angle * 0.5 + motor_id) * 2.0, 6),
        "current": None,
        "temperature": {
            "mos": round(32.0 + math.sin(angle * 0.25) * 1.5, 3),
            "rotor": round(29.0 + math.cos(angle * 0.25) * 1.0, 3),
        },
        "status_code": 0,
        "error_code": None,
        "freshness": FRESHNESS_FRESH,
    }


def build_simulation_frame(
    sequence: int,
    channel: str,
    expected_ids: Sequence[int],
    present_ids: Sequence[int],
) -> Dict[str, Any]:
    """Build one deterministic telemetry frame.

    Joints whose ID is not in *present_ids* carry all-null fields with
    freshness ``none`` (mirrors scan semantics: never fabricate state for a
    motor that is not confirmed present).
    """
    present = set(present_ids)
    joints = []
    for motor_id in expected_ids:
        if motor_id in present:
            joint = {"id": motor_id, **_sim_joint_values(motor_id, sequence)}
        else:
            joint = {"id": motor_id, **_JOINT_NULL}
        joints.append(joint)
    return {
        "timestamp": utc_now_iso(),
        "sequence": sequence,
        "channel": channel,
        "source": SOURCE_SIMULATION,
        # Identical frame contract in every mode — units included.
        "units": dict(UNITS),
        "joints": joints,
    }


async def put_latest(queue: "asyncio.Queue", frame: Dict[str, Any]) -> None:
    """Publish *frame* to a bounded queue, keeping only the newest item.

    Slow consumers never block the producer: when the queue is full the
    oldest queued frame is dropped. With ``maxsize=1`` a consumer always
    sees the most recent frame.
    """
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:  # pragma: no cover - race guard only
            pass
    queue.put_nowait(frame)


async def stream_simulation_telemetry(websocket, service, settings) -> None:
    """Stream deterministic telemetry frames over an accepted WebSocket.

    Architecture (task: slow clients keep only the latest data):

    * a *producer* task generates frames at ``settings.telemetry_hz`` into a
      bounded ``asyncio.Queue(maxsize=1)`` via :func:`put_latest` — it never
      waits on the client;
    * this coroutine is the single *consumer*: it drains the queue and sends
      frames. A slow client therefore drops intermediate frames and always
      receives the newest one.

    Stop conditions (task: stop and release after disconnect or generation
    invalidation):

    * the client disconnects (watcher task sets ``stop``);
    * ``service.generation`` changed since this connection opened
      (a ``disconnect`` invalidated the session);
    * the send itself fails.

    In every case the producer is cancelled before returning, so no task or
    frame buffer outlives the connection. No CAN/SDK resources are held by
    the simulation source.
    """
    queue: asyncio.Queue = asyncio.Queue(maxsize=1)
    start_generation = service.generation
    stop = asyncio.Event()

    async def produce() -> None:
        sequence = 0
        period = 1.0 / settings.telemetry_hz
        while not stop.is_set():
            sequence += 1
            frame = build_simulation_frame(
                sequence,
                settings.channel,
                settings.expected_ids,
                settings.sim_found_ids,
            )
            await put_latest(queue, frame)
            try:
                await asyncio.wait_for(stop.wait(), timeout=period)
            except asyncio.TimeoutError:
                pass

    async def watch_client() -> None:
        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
        except Exception:
            # Any receive error means the peer is gone.
            pass
        stop.set()

    producer = asyncio.create_task(produce())
    watcher = asyncio.create_task(watch_client())
    try:
        while not stop.is_set():
            if service.generation != start_generation:
                # Session invalidated by a disconnect: stop streaming and
                # close the socket. No stale telemetry survives disconnects.
                break
            try:
                frame = await asyncio.wait_for(queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                continue
            try:
                await websocket.send_json(frame)
            except Exception:
                # The peer is gone: a disconnect can race an in-flight send
                # (WebSocketDisconnect from send_json). Treat any send
                # failure as a normal end of stream; the finally block
                # cancels producer/watcher and closes best-effort.
                break
    finally:
        stop.set()
        for task in (producer, watcher):
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        # Best effort: close our side. The client may already be gone.
        try:
            await websocket.close(code=1000)
        except Exception:
            pass
