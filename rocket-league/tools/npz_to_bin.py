"""Stitch a recorded 5-minute bot game (one .npz per goal-to-goal segment) into ONE compact binary timeline
for the web viewer: <out>/<id>.bin + <out>/<id>.json (header). Reads only numpy arrays (positions, rotations,
boost, pad states); the embedded meta json (local paths) is never copied.

    python tools/npz_to_bin.py <id> <segments_dir> <out_dir> --label "..." --opp Nexto --size 3

Timeline: segments in order at 30 Hz, each followed (after a goal) by HOLD frozen frames (goal celebration).
Hold frames carry flag bit0 so the viewer's game clock skips them. Binary layout, little endian, per frame:
  u8 flags (bit0 = hold)          | u8[5] pad bits (34 pads, bit k = active)
  ball: i16 x,y,z (1/4 uu), i16 wx,wy,wz (1/1000 rad/s)       12 bytes
  per car: i16 x,y,z (1/4 uu), i16 qx,qy,qz,qw (/32767, THREE-space quaternion of the car model, see below),
           u8 boost (0..100), u8 flags (bit0 boosting, bit1 demolished, bit2 on ground)   16 bytes
World (x,y,z) -> three (x,z,y) is a reflection that un-mirrors RocketSim's left-handed world; the car model has
local X = forward, Y = up, Z = forward x up (in three space), which is a proper rotation. Ball angular velocity
is stored in three space too (pseudovector: (wx,wz,wy) negated by the reflection)."""
import argparse, json, sys
from pathlib import Path
import numpy as np

HZ_IN, HZ_OUT = 120, 30
STEP = HZ_IN // HZ_OUT
HOLD = 60                      # 2 s frozen after a goal (explosion + banner)
L = 5120.0                     # field half length (back wall)


def mat_to_quat(m):            # m: [N,3,3] proper rotations (columns = basis) -> [N,4] x,y,z,w
    N = len(m)
    q = np.zeros((N, 4))
    tr = m[:, 0, 0] + m[:, 1, 1] + m[:, 2, 2]
    for i in range(N):
        R = m[i]
        if tr[i] > 0:
            s = np.sqrt(tr[i] + 1) * 2
            q[i] = [(R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s, s / 4]
        elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
            s = np.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
            q[i] = [s / 4, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s, (R[2, 1] - R[1, 2]) / s]
        elif R[1, 1] > R[2, 2]:
            s = np.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
            q[i] = [(R[0, 1] + R[1, 0]) / s, s / 4, (R[1, 2] + R[2, 1]) / s, (R[0, 2] - R[2, 0]) / s]
        else:
            s = np.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
            q[i] = [(R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, s / 4, (R[1, 0] - R[0, 1]) / s]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def car_quat(rot):             # rot [T,3,3] columns fwd,right,up (world) -> three-space quaternion [T,4]
    f = rot[:, :, 0][:, [0, 2, 1]]
    u = rot[:, :, 2][:, [0, 2, 1]]
    z = np.cross(f, u); z /= np.linalg.norm(z, axis=1, keepdims=True)
    u = np.cross(z, f); u /= np.linalg.norm(u, axis=1, keepdims=True)
    m = np.stack([f, u, z], axis=2)                      # columns
    q = mat_to_quat(m)
    for i in range(1, len(q)):                           # hemisphere continuity
        if (q[i] * q[i - 1]).sum() < 0:
            q[i] = -q[i]
    return q


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("id"); ap.add_argument("src"); ap.add_argument("out")
    ap.add_argument("--label", required=True); ap.add_argument("--opp", required=True)
    ap.add_argument("--note", default="")
    ap.add_argument("--max-seconds", type=float, default=300.0, help="game length; the segment crossing it is trimmed (time expired)")
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out); out.mkdir(parents=True, exist_ok=True)
    idx = json.loads((src / "index.json").read_text())
    idx = sorted(idx, key=lambda r: r["file"])
    frames_ball, frames_car, frames_pad, frames_flag = [], [], [], []
    goals, resets = [], []                               # goals: [frame, team]; resets: kickoff start frames
    team = None; pad_pos = pad_big = None
    cum = 0                                              # output frame counter
    sim_s = 0.0
    fwd_pos = fwd_n = 0
    for r in idx:
        d = np.load(src / r["file"])
        d = {k: d[k] for k in d.files if k != "meta_json"}
        tick = d["tick"]; assert (np.diff(tick) == 1).all()
        T = len(tick)
        trimmed = False
        allow = int(round((a.max_seconds - sim_s) * HZ_IN))
        if T - 1 > allow:                                # the clock ran out inside this segment
            trimmed = True
            d = {k: (v[:allow + 1] if v.ndim and len(v) == T and k not in ("car_id", "car_team", "pad_pos", "pad_big", "goal_tick", "goal_team") else v) for k, v in d.items()}
            d["goal_tick"] = d["goal_tick"][:0]; d["goal_team"] = d["goal_team"][:0]
            T = allow + 1; tick = d["tick"]
        sel = np.unique(np.r_[np.arange(0, T, STEP), T - 1])
        tm = d["car_team"].astype(int); C = len(tm)
        if team is None:
            team = tm; pad_pos = d["pad_pos"]; pad_big = d["pad_big"]
        assert (tm == team).all()
        hb = d["car_hitbox_size"][0]; assert abs(hb[0] - 120.5) < 1 and abs(hb[1] - 86.7) < 1   # Octane
        bp, bv = d["ball_pos"], d["ball_vel"]
        gt, gteam = d["goal_tick"], d["goal_team"].astype(int)
        # --- sanity: blue (team 0) attacks +y; the ball ends in the correct net; kickoff starts at the centre
        assert np.hypot(bp[0, 0], bp[0, 1]) < 5, ("kickoff ball not at centre", r["file"])
        if len(gt):
            end = bp[-1]
            assert (end[1] > L) if gteam[0] == 0 else (end[1] < -L), (r["file"], end)
        fwd = d["car_rot"][:, :, :, 0]; sp = np.linalg.norm(d["car_vel"], axis=-1)
        m = d["car_on_ground"] & (sp > 800)
        if m.any():
            dots = (fwd * d["car_vel"]).sum(-1)[m] / sp[m]
            assert (dots > 0).mean() > 0.6, (r["file"], (dots > 0).mean())      # per segment (reversing happens)
            fwd_pos += int((dots > 0).sum()); fwd_n += len(dots)
        resets.append(cum)
        ctl = d["car_controls"][:, :, 6]; bo = d["car_boost"]
        n = len(sel)
        ball = np.concatenate([np.round(bp[sel] * 4), np.round(d["ball_angvel"][sel][:, [0, 2, 1]] * -1000)], axis=1)
        cars = []
        for c in range(C):
            q = car_quat(d["car_rot"][sel, c])
            # boosting: the boost amount fell over the last 4 physics ticks, or the control was held
            b_prev = bo[np.maximum(sel - STEP, 0), c]
            boosting = ((bo[sel, c] < b_prev - 1e-3) | (ctl[np.maximum(sel - 1, 0), c] > 0.5)) & (bo[sel, c] > 0.0)
            fl = boosting.astype(np.uint8) | (d["car_demoed"][sel, c].astype(np.uint8) << 1) | (d["car_on_ground"][sel, c].astype(np.uint8) << 2)
            cars.append(np.concatenate([np.round(d["car_pos"][sel, c] * 4), np.round(q * 32767), np.round(bo[sel, c])[:, None], fl[:, None]], axis=1))
        pa = d["pad_active"][sel]                         # [n,34]
        packed = np.packbits(pa, axis=1, bitorder="little")
        fb = [ball]; fc = [np.stack(cars, axis=1)]; fp = [packed]; ff = [np.zeros(n, np.uint8)]
        cum += n
        sim_s += (T - 1) / HZ_IN
        if len(gt):
            goals.append([cum - 1, int(gteam[0])])
            fb.append(np.repeat(ball[-1:], HOLD, 0)); fc.append(np.repeat(fc[0][-1:], HOLD, 0)); fp.append(np.repeat(packed[-1:], HOLD, 0))
            ff.append(np.ones(HOLD, np.uint8))
            cum += HOLD
        frames_ball += fb; frames_car += fc; frames_pad += fp; frames_flag += ff
        if trimmed or sim_s >= a.max_seconds - 1e-6:
            break
    assert fwd_n == 0 or fwd_pos / fwd_n > 0.85, ("cars do not drive along their nose", fwd_pos / fwd_n)
    ball = np.concatenate(frames_ball); cars = np.concatenate(frames_car); pad = np.concatenate(frames_pad); flag = np.concatenate(frames_flag)
    N, C = len(ball), cars.shape[1]
    # int16 packing
    assert np.abs(ball[:, :6]).max() < 32767 and np.abs(cars[:, :, :7]).max() <= 32767
    rec_dtype = np.dtype([("flag", "u1"), ("pad", "u1", (5,)), ("ball", "<i2", (6,)),
                          ("car", np.dtype([("p", "<i2", (3,)), ("q", "<i2", (4,)), ("b", "u1"), ("f", "u1")]), (C,))])
    rec = np.zeros(N, rec_dtype)
    rec["flag"] = flag; rec["pad"] = pad; rec["ball"] = ball
    rec["car"]["p"] = cars[:, :, 0:3]; rec["car"]["q"] = cars[:, :, 3:7]
    rec["car"]["b"] = cars[:, :, 7]; rec["car"]["f"] = cars[:, :, 8]
    # hold frames: no boost flame
    hm = flag == 1
    rec["car"]["f"][hm] &= 0b110
    raw = rec.tobytes()
    assert rec_dtype.itemsize == 1 + 5 + 12 + 16 * C
    (out / f"{a.id}.bin").write_bytes(raw)
    score = [0, 0]
    for _, t in goals: score[t] += 1
    hdr = {"v": 2, "id": a.id, "label": a.label, "opp": a.opp, "note": a.note, "hz": HZ_OUT, "frames": int(N), "frameBytes": int(rec_dtype.itemsize),
           "teams": [int(t) for t in team], "hold": HOLD, "goals": goals, "kickoffs": resets, "finalScore": score,
           "gameSeconds": round(sim_s, 1), "padPos": [[int(round(v)) for v in r] for r in pad_pos], "padBig": [int(v) for v in pad_big]}
    (out / f"{a.id}.json").write_text(json.dumps(hdr, separators=(",", ":")))
    import gzip
    print(f"{a.id}: {N} frames ({N/HZ_OUT:.0f}s timeline, {sim_s:.1f}s of play), {len(raw)/1e6:.2f} MB raw, {len(gzip.compress(raw))/1e6:.2f} MB gz, score {score}, {len(idx)} segments")


if __name__ == "__main__":
    main()
