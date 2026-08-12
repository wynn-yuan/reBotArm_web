"""Phase 7I redo oracle — ZERO-TX passive receive cross-check.

Opens a motorbridge Controller on can1, registers motors 1..7, and ONLY
polls incoming status frames (poll_feedback_once + get_state). It never
calls set_active_report, ping, enable, or any other transmitting API.
Purpose: cross-validate the raw-bytes passive parser against the vendor
SDK's own parsing of the same spontaneous frames.

Release follows the audited vendor scan pattern: motor.close() per handle,
close_bus() (motors were bound), Controller.close(). Never shutdown().
"""
import json
import time

import motorbridge

CHANNEL = "can1"
HOST_ID = 0xFD
MODELS = {1: "rs-06", 2: "rs-06", 3: "rs-06", 4: "rs-00", 5: "rs-00", 6: "rs-00", 7: "rs-00"}

assert motorbridge.__version__ == "0.5.1", motorbridge.__version__

print("ORACLE_OPEN", time.time_ns())
ctrl = motorbridge.Controller(CHANNEL)
motors = {}
for mid, model in MODELS.items():
    motors[mid] = ctrl.add_robstride_motor(mid, HOST_ID, model)

deadline = time.monotonic() + 2.0
polls = 0
while time.monotonic() < deadline:
    ctrl.poll_feedback_once()
    polls += 1

print("ORACLE_SAMPLE", time.time_ns(), "polls", polls)
out = {}
for mid in sorted(MODELS):
    st = motors[mid].get_state()
    if st is None:
        out[mid] = None
        continue
    out[mid] = {
        "can_id": getattr(st, "can_id", None),
        "arbitration_id": getattr(st, "arbitration_id", None),
        "status_code": getattr(st, "status_code", None),
        "pos": getattr(st, "pos", None),
        "vel": getattr(st, "vel", None),
        "torq": getattr(st, "torq", None),
        "t_mos": getattr(st, "t_mos", None),
        "t_rotor": getattr(st, "t_rotor", None),
    }
print("ORACLE_JSON", json.dumps(out))

for mid in sorted(MODELS):
    motors[mid].close()
ctrl.close_bus()
ctrl.close()
print("ORACLE_DONE", time.time_ns())
