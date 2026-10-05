"""Build data/ for the viewer from recorded full games.  python tools/build_games.py <recordings_root> <out_dir>
<recordings_root> holds one folder of per-goal .npz segments (+ index.json) per game, as written by scripts/record_teams.py."""
import json, subprocess, sys
from pathlib import Path
here = Path(__file__).parent
root, out = Path(sys.argv[1]), Path(sys.argv[2])
GAMES = [  # id, folder, mode label, opponent, note[, recordings root override]
    ("3v3_nexto", "3v3_nexto", "3v3", "Nexto", "Terminal (T8 checkpoint) vs Nexto, argmax play, from a kickoff."),
    ("3v3_chadgpt", "3v3_chadgpt", "3v3", "ChadGPT", "Terminal (T8 checkpoint) vs ChadGPT, argmax play, from a kickoff."),
    ("2v2_nexto", "2v2_nexto_s20261004", "2v2", "Nexto", "Terminal (T8 checkpoint) vs Nexto, argmax play, from a kickoff. One of three recorded games (final scores 1-0, 2-1 and 10-1); this is the one closest to the average of our 128-game evaluation (6.3-0.8)."),
    ("1v1_nexto", "1v1_nexto", "1v1", "Nexto", "Terminal (K6v3 checkpoint) vs Nexto, argmax play, from a kickoff.", "/home/cbalfour/rlrl/out/videos/site_fullgames_it238"),
]
out.mkdir(parents=True, exist_ok=True); index = []
for gid, folder, mode, opp, note, *own in GAMES:
    src = Path(own[0]) / folder if own else root / folder
    if not (src / "index.json").exists(): print("missing", src); continue
    subprocess.run([sys.executable, str(here / "npz_to_bin.py"), gid, str(src), str(out), "--label", f"{mode}: Terminal vs {opp}", "--opp", opp, "--note", note], check=True)
    h = json.loads((out / f"{gid}.json").read_text())
    sc = h["finalScore"]
    index.append({"id": gid, "label": f"{mode}: Terminal vs {opp} (final {sc[0]}-{sc[1]})", "opp": opp, "hdr": f"data/{gid}.json", "bin": f"data/{gid}.bin"})
(out / "index.json").write_text(json.dumps(index, indent=1))
