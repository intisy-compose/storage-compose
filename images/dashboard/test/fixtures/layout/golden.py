"""Writes drive-sync-plans.json: what tools/drive-sync plans for pc, p53 and the array from drive-sync.toml,
as it is ("today") and with p53 and the array joined ("joined").

Run from anywhere with `python -I images/dashboard/test/fixtures/layout/golden.py`; nodePlan's golden
test compares against the result and makes the joined variant with the same replacement.
"""
import json
import sys
import tomllib
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[4] / "tools" / "drive-sync"))

from drive_sync.config import parse  # noqa: E402
from drive_sync.plan import plan_for  # noqa: E402

today = (HERE / "drive-sync.toml").read_text(encoding="utf-8")
variants = {"today": today, "joined": today.replace("joined = false", "joined = true").replace("joined     = false", "joined     = true")}
plans = {
    variant: {name: [asdict(plan) for plan in plan_for(parse(tomllib.loads(text)), name)] for name in ("pc", "p53", "array")}
    for variant, text in variants.items()
}
(HERE / "drive-sync-plans.json").write_text(json.dumps(plans, indent=2) + "\n", encoding="utf-8", newline="\n")
