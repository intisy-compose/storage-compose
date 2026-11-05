"""Writes drive-sync-plans.json: what tools/drive-sync plans for pc and the array from drive-sync.toml.

Run from anywhere with `python -I images/dashboard/test/fixtures/layout/golden.py`; nodePlan's golden
test compares against the result.
"""
import json
import sys
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[4] / "tools" / "drive-sync"))

from drive_sync.config import load  # noqa: E402
from drive_sync.plan import plan_for  # noqa: E402

layout = load(HERE / "drive-sync.toml")
plans = {name: [asdict(plan) for plan in plan_for(layout, name)] for name in ("pc", "array")}
(HERE / "drive-sync-plans.json").write_text(json.dumps(plans, indent=2) + "\n", encoding="utf-8", newline="\n")
