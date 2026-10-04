"""Convert recorded bot-game .npz files (positions only) into compact 30 Hz JSON for the web viewer.

Reads only numpy arrays; the embedded meta json (which holds local paths) is never copied.
Usage: python tools/npz_to_json.py <src_root> <out_dir>
"""
import gzip, json, sys
from pathlib import Path
import numpy as np

HZ_IN, HZ_OUT = 120, 30
STEP = HZ_IN // HZ_OUT
SRC = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
B = "out/videos/best_2026-10-03/"
K = B + "k6_1v1/sp1v1_attn_k6_big2gpu_s0_it238_vs_nexto_"
# (id, file, label, opponent, our side 0=blue, honest note)
GAMES = [
    ("1v1_win", K + "win_random107_s0.npz", "1v1: Terminal (K6) vs Nexto - win", "Nexto", "Start from a random (non-kickoff) state."),
    ("1v1_loss", K + "loss_random255_s0.npz", "1v1: Terminal (K6) vs Nexto - loss (we concede)", "Nexto", "Start from a random state. A loss, shown honestly."),
    ("2v2_seg001", B + "2v2_nexto/2v2_seg001_blue_goal_36.4s.npz", "2v2: Terminal (T8) vs Nexto - win", "Nexto", "Excerpt of a 5-minute game ending in a goal."),
    ("2v2_seg005", B + "2v2_nexto/2v2_seg005_blue_goal_6.8s.npz", "2v2: Terminal (T8) vs Nexto - quick goal", "Nexto", "Excerpt of a 5-minute game ending in a goal."),
    ("2v2_seg000", B + "2v2_nexto/2v2_seg000_orange_goal_16.0s.npz", "2v2: Terminal (T8) vs Nexto - goal against us", "Nexto", "Excerpt where Nexto scores."),
    ("3v3_nexto_007", B + "3v3_nexto/3v3_seg007_blue_goal_17.4s.npz", "3v3: Terminal (T8) vs Nexto - win", "Nexto", "Excerpt of a 5-minute game ending in a goal."),
    ("3v3_nexto_002", B + "3v3_nexto/3v3_seg002_blue_goal_33.3s.npz", "3v3: Terminal (T8) vs Nexto - win (long rally)", "Nexto", "Excerpt of a 5-minute game ending in a goal."),
    ("3v3_chad_010", B + "3v3_chadgpt/3v3_seg010_blue_goal_21.1s.npz", "3v3: Terminal (T8) vs ChadGPT - win", "ChadGPT", "Excerpt of a 5-minute game ending in a goal."),
    ("3v3_chad_001", B + "3v3_chadgpt/3v3_seg001_orange_goal_6.2s.npz", "3v3: Terminal (T8) vs ChadGPT - goal against us", "ChadGPT", "Excerpt where ChadGPT scores."),
]

def sw(a):  # world (x,y,z) -> three (x,z,y); a reflection, which fixes the left-handed world
    return a[..., [0, 2, 1]]

index = []
for gid, rel, label, opp, note in GAMES:
    d = np.load(SRC / rel)
    tick = d["tick"]; assert (np.diff(tick) == 1).all()
    T = len(tick)
    idx = np.unique(np.r_[np.arange(0, T, STEP), T - 1])
    team = d["car_team"].astype(int); C = len(team)
    ball = d["ball_pos"][idx]
    gt = d["goal_tick"]; gteam = d["goal_team"].astype(int)
    assert len(gt) >= 1
    # Coordinate checks: blue (team 0) attacks +y, so a blue goal ends with the ball beyond y=+5120.
    last = d["ball_pos"][-1]
    if gteam[0] == 0: assert last[1] > 5120, (gid, last)
    else: assert last[1] < -5120, (gid, last)
    # Cars drive forward along their forward vector (fast, on the ground).
    vel, rot, og = d["car_vel"], d["car_rot"], d["car_on_ground"]
    fwd = rot[:, :, :, 0]
    sp = np.linalg.norm(vel, axis=-1); m = og & (sp > 800)
    dots = (fwd * vel).sum(-1)[m] / sp[m]
    assert (dots > 0).mean() > 0.9, (gid, (dots > 0).mean())
    cars = []
    for c in range(C):
        p = d["car_pos"][idx, c]; R = rot[idx, c]
        f = R[:, :, 0]; u = R[:, :, 2]
        arr = np.concatenate([np.round(p), np.round(f, 3), np.round(u, 3)], axis=1)
        cars.append([int(v) if float(v).is_integer() else float(v) for v in arr.ravel()])
    pa = d["pad_active"][idx]
    ev = []
    prev = np.ones(pa.shape[1], bool)
    for i in range(len(idx)):
        for k in np.nonzero(pa[i] != prev)[0]:
            ev.append([i, int(k), int(pa[i, k])])
        prev = pa[i]
    init_pad = [int(v) for v in d["pad_active"][idx][0]]
    goals = [[int(np.searchsorted(idx, np.nonzero(tick >= t)[0][0])), int(g)] for t, g in zip(gt, gteam)]
    obj = {
        "v": 1, "hz": HZ_OUT, "id": gid, "label": label, "opp": opp, "note": note,
        "frames": int(len(idx)), "team": team.tolist(),
        "ball": [int(v) for v in np.round(ball).ravel()],
        "cars": cars,
        "boost": [[int(v) for v in np.round(d["car_boost"][idx, c])] for c in range(C)],
        "demo": [[int(v) for v in d["car_demoed"][idx, c]] for c in range(C)],
        "padPos": [[int(round(v)) for v in r] for r in d["pad_pos"]],
        "padBig": [int(v) for v in d["pad_big"]],
        "pad0": init_pad, "padEv": ev, "goals": goals,
    }
    s = json.dumps(obj, separators=(",", ":"))
    (OUT / f"{gid}.json").write_text(s)
    gz = len(gzip.compress(s.encode()))
    print(f"{gid}: {len(idx)} frames, {len(s)/1e3:.0f} KB raw, {gz/1e3:.0f} KB gz, ball end {last[:2]}, fwd.vel>0 {np.mean(dots>0):.3f}")
    index.append({"id": gid, "label": label, "opp": opp, "note": note, "file": f"data/{gid}.json", "seconds": round((len(idx)-1)/HZ_OUT, 1)})
(OUT / "index.json").write_text(json.dumps(index, indent=1))
