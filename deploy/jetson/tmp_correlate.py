"""Correlate raw candump frames with SDK-parsed WS telemetry values."""
import json
import re
from collections import defaultdict

RAW = "/tmp/raw7i.log"
WS = "/tmp/ws7i.json"

line_re = re.compile(r"\((\d+\.\d+)\)\s+can1\s+([0-9A-Fa-f]+)\s+\[(\d+)\]\s+((?:[0-9A-Fa-f]{2}\s?)+)")

# ---- parse raw ----
raw = defaultdict(list)  # motor_id -> [(ts, bytes8)]
with open(RAW) as fh:
    for line in fh:
        m = line_re.search(line)
        if not m:
            continue
        ts = float(m.group(1))
        arb = int(m.group(2), 16)
        data = bytes(int(x, 16) for x in m.group(4).split())
        if arb & 0xFF != 0xFD or arb >> 24 != 0x18:
            print("UNEXPECTED ARB", hex(arb))
            continue
        mid = (arb >> 8) & 0xFF
        raw[mid].append((ts, data))

print("raw motors:", sorted(raw), "frames per motor:", {k: len(v) for k, v in sorted(raw.items())})

# ---- parse ws ----
with open(WS) as fh:
    ws_frames = json.load(fh)
print("ws frames:", len(ws_frames))

def be16(b, off):
    return int.from_bytes(b[off:off+2], "big", signed=True)

# ---- build (raw, value) pairs for each candidate field ----
pairs = defaultdict(list)  # (motor, field) -> [(rawA, rawB, rawC, b6, b7, values)]
rows = []
for item in ws_frames:
    arr = item["arrival_epoch"]
    frame = item["frame"]
    for j in frame["joints"]:
        mid = j["id"]
        if j["freshness"] != "fresh":
            continue
        # nearest raw frame at or before arrival (+2ms slack)
        cand = [r for r in raw[mid] if r[0] <= arr + 0.002]
        if not cand:
            continue
        ts, data = cand[-1]
        rows.append((mid, arr - ts, data, j))

print("matched rows:", len(rows))
# freshness of match
dts = [r[1] for r in rows]
print("match dt ms: min %.2f max %.2f avg %.2f" % (min(dts)*1e3, max(dts)*1e3, sum(dts)/len(dts)*1e3))

# ---- candidate scales ----
# Try: pos = f(pair), candidates: pair index 0,1,2 with offsets {0}
# and scale solved by least squares across all rows.
import statistics

def solve_scale(pairs_list):
    # value = raw * s  -> s = sum(raw*val)/sum(raw*raw)
    num = sum(r * v for r, v in pairs_list)
    den = sum(r * r for r, v in pairs_list)
    return num / den if den else None

fields = ["position", "velocity", "torque"]
for pi, poff in [(0, "bytes0-1"), (1, "bytes2-3"), (2, "bytes4-5")]:
    for field in fields:
        plist = []
        for mid, dt, data, j in rows:
            rawv = be16(data, pi * 2)
            val = j[field]
            if val is None:
                continue
            plist.append((rawv, val))
        s = solve_scale(plist)
        # residual in LSB
        if s:
            res = [abs(v - r * s) / abs(s) for r, v in plist]
            print(f"{poff} as {field}: scale={s:.6e} max_resid={max(res):.2f} LSB avg={statistics.mean(res):.2f}")

# byte6/byte7 vs status/temp
print("\nbyte6/byte7 distinct vs fields:")
seen = {}
for mid, dt, data, j in rows:
    key = (data[6], data[7])
    if key not in seen:
        seen[key] = (mid, j["status_code"], j["temperature"]["mos"], j["temperature"]["rotor"])
for k, v in sorted(seen.items()):
    print(f"  b6=0x{k[0]:02X}({k[0]}) b7=0x{k[1]:02X}({k[1]}) motor={v[0]} status={v[1]} t_mos={v[2]} t_rotor={v[3]}")

# sample rows for eyeballing
print("\nsample rows (motor dt_ms raw_hex pos vel torq tmos trotor status):")
for mid, dt, data, j in rows[:14]:
    print(f"  M{mid} dt={dt*1e3:5.1f} {data.hex()} pos={j['position']:+.4f} vel={j['velocity']:+.4f} torq={j['torque']:+.4f} tmos={j['temperature']['mos']} trotor={j['temperature']['rotor']} st={j['status_code']}")
