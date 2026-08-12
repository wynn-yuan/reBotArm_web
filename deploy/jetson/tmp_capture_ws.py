"""Phase 7I redo — raw-frame <-> SDK-value correlation capture (ZERO WRITE).

Subscribes to the ALREADY-RUNNING telemetry session (adding a subscriber
performs no motor writes) and records N WS frames with arrival timestamps,
while candump captures raw frames. Correlation of the two yields the byte
layout + scaling of the RobStride comm_type 24 status frame.

Usage: python3 capture_ws.py <num_frames> <out_json>
"""
import asyncio
import json
import sys
import time

import websockets

URI = "ws://127.0.0.1:8000/ws/robot/telemetry"


async def main() -> None:
    n = int(sys.argv[1])
    out_path = sys.argv[2]
    frames = []
    async with websockets.connect(URI, max_size=1_000_000) as ws:
        print("WS_CONNECTED", time.time(), flush=True)
        for _ in range(n):
            msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
            arrival = time.time()
            frames.append({"arrival_epoch": arrival, "frame": json.loads(msg)})
    print("WS_DONE", time.time(), flush=True)
    with open(out_path, "w") as fh:
        json.dump(frames, fh)


asyncio.run(main())
