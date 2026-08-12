#!/usr/bin/env python3
"""rebotarm-telemetry-check.py — Phase 7G read-only telemetry verification.

Connects to ``ws://127.0.0.1:8000/ws/robot/telemetry``, receives a bounded
number of frames, validates each one against the audited motorbridge 0.5.1
frame contract, prints a summary and exits. Closing the socket is the normal
end of the check: the server then performs its authorized cleanup
(``robstride_set_active_report(False)`` per enabled motor + audited
read-only release) — see ``apps/server/src/rebot_server/activereport.py``.

SAFETY (hard):
* This client ONLY RECEIVES. It never sends application data on the
  WebSocket, never calls any HTTP endpoint other than nothing, and never
  writes to any motor. Opening the telemetry socket is what starts the
  server-side active-report session — that is the single authorized write,
  performed by the server, not by this script.
* A rejection frame (``telemetry_not_allowed`` / ``telemetry_requires_connected``
  / ``telemetry_error``) means the gates correctly stayed closed: the script
  reports it and exits non-zero WITHOUT any motor having been touched.

Usage (on the Jetson, with the deployment venv):
    ~/rebotarm-web/shared/venv/bin/python rebotarm-telemetry-check.py
    # options: --url ws://127.0.0.1:8000/ws/robot/telemetry  --frames 15
    #          --timeout 10

Exit codes:
    0  all received frames valid AND at least one joint delivered real data
    1  contract violation or transport failure
    3  server rejected the connection via an error frame (gates closed;
       zero motor writes — this is a SAFE outcome, not a fault)
    4  frames valid but every joint stayed null/"none" (contract allows it;
       real hardware should report — see README §5.2 residual risk)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

EXPECTED_IDS = [1, 2, 3, 4, 5, 6, 7]
EXPECTED_UNITS = {
    "position": "rad",
    "velocity": "rad/s",
    "torque": "Nm",
    "temperature": "degC",
}

try:  # websockets >= 13 (deployment venv ships 16.x)
    from websockets.asyncio.client import connect
except ImportError:  # pragma: no cover - older websockets fallback
    from websockets import connect  # type: ignore


def fail(message: str, code: int) -> "asyncio.Future":
    print(f"FAIL: {message}", file=sys.stderr)
    raise SystemExit(code)


def validate_frame(frame: dict, previous_sequence: int) -> list[str]:
    """Return a list of contract violations (empty when the frame is valid)."""
    problems = []

    if "error" in frame:
        # Handled by the caller before validation.
        return ["error frame"]

    for key in ("timestamp", "sequence", "channel", "source", "units", "joints"):
        if key not in frame:
            problems.append(f"missing key {key!r}")
    if problems:
        return problems

    if frame["units"] != EXPECTED_UNITS:
        problems.append(f"unexpected units: {frame['units']!r}")
    if frame["source"] != "motorbridge":
        problems.append(f"unexpected source: {frame['source']!r}")

    sequence = frame["sequence"]
    if not isinstance(sequence, int) or sequence <= previous_sequence:
        problems.append(
            f"sequence not strictly increasing: {previous_sequence} -> {sequence!r}"
        )

    joints = frame["joints"]
    if not isinstance(joints, list) or [j.get("id") for j in joints] != EXPECTED_IDS:
        problems.append(f"joints must be exactly IDs {EXPECTED_IDS}")
        return problems

    for joint in joints:
        # current / error_code have no MotorState source in 0.5.1: must stay
        # null — never fabricated.
        if joint.get("current") is not None:
            problems.append(f"joint {joint['id']}: current must be null")
        if joint.get("error_code") is not None:
            problems.append(f"joint {joint['id']}: error_code must be null")
        freshness = joint.get("freshness")
        if freshness not in ("fresh", "none"):
            problems.append(f"joint {joint['id']}: bad freshness {freshness!r}")
        elif freshness == "none":
            for field in ("position", "velocity", "torque", "status_code"):
                if joint.get(field) is not None:
                    problems.append(
                        f"joint {joint['id']}: freshness none but {field} set"
                    )
        else:  # fresh
            for field in ("position", "velocity", "torque"):
                value = joint.get(field)
                if not isinstance(value, (int, float)):
                    problems.append(
                        f"joint {joint['id']}: fresh but {field} not numeric"
                    )
            temperature = joint.get("temperature")
            if not isinstance(temperature, dict) or set(temperature) != {
                "mos",
                "rotor",
            }:
                problems.append(
                    f"joint {joint['id']}: temperature must be mos/rotor dict"
                )
    return problems


async def run(url: str, frame_count: int, timeout: float) -> int:
    try:
        client = await asyncio.wait_for(connect(url), timeout=timeout)
    except Exception as exc:
        print(f"FAIL: cannot connect to {url}: {type(exc).__name__}: {exc}",
              file=sys.stderr)
        return 1

    print(f"connected: {url}")
    previous_sequence = 0
    fresh_joint_seen = False
    position_min, position_max = None, None
    frames_received = 0

    try:
        while frames_received < frame_count:
            try:
                raw = await asyncio.wait_for(client.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                print(f"FAIL: no frame within {timeout}s", file=sys.stderr)
                return 1
            frame = json.loads(raw)

            if "error" in frame:
                # Gates closed or session start failed — fail closed, zero
                # motor writes. Report exactly what the server said.
                error = frame["error"]
                print(
                    "REJECTED (safe, zero motor writes): "
                    f"code={error.get('code')!r} message={error.get('message')!r}"
                )
                return 3

            problems = validate_frame(frame, previous_sequence)
            if problems:
                for problem in problems:
                    print(f"CONTRACT VIOLATION: {problem}", file=sys.stderr)
                print(f"offending frame: {json.dumps(frame)[:2000]}",
                      file=sys.stderr)
                return 1

            previous_sequence = frame["sequence"]
            frames_received += 1
            for joint in frame["joints"]:
                if joint["freshness"] == "fresh":
                    fresh_joint_seen = True
                    position = joint["position"]
                    position_min = (
                        position if position_min is None
                        else min(position_min, position)
                    )
                    position_max = (
                        position if position_max is None
                        else max(position_max, position)
                    )
    finally:
        # Normal close: the server then runs its authorized cleanup
        # (set_active_report(False) per enabled motor + audited release).
        try:
            await client.close()
        except Exception:
            pass

    print(f"frames received : {frames_received} (sequence up to {previous_sequence})")
    print(f"fresh joints    : {'yes' if fresh_joint_seen else 'NONE (all null)'}")
    if fresh_joint_seen:
        print(f"position range  : {position_min:+.4f} .. {position_max:+.4f} rad")
    sample = json.loads(raw)
    print("last frame      :")
    print(json.dumps(sample, indent=2)[:2500])

    if not fresh_joint_seen:
        print(
            "NOTE: every joint stayed null/'none'. The contract allows this "
            "(never fabricate), but real motors with active reporting should "
            "deliver status frames — see apps/server README §5.2 residual "
            "risk (the vendor's 0x7026 parameter write is NOT authorized).",
            file=sys.stderr,
        )
        return 4
    print("OK: all frames valid; real (read-only) telemetry received.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read-only telemetry verification client (receive only)."
    )
    parser.add_argument(
        "--url", default="ws://127.0.0.1:8000/ws/robot/telemetry",
        help="telemetry WebSocket URL (default: %(default)s)",
    )
    parser.add_argument(
        "--frames", type=int, default=15,
        help="number of frames to receive before closing (default: %(default)s)",
    )
    parser.add_argument(
        "--timeout", type=float, default=10.0,
        help="connect/receive timeout in seconds (default: %(default)s)",
    )
    args = parser.parse_args()
    if args.frames < 1:
        parser.error("--frames must be >= 1")
    return asyncio.run(run(args.url, args.frames, args.timeout))


if __name__ == "__main__":
    raise SystemExit(main())
