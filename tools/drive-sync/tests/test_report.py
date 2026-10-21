import tempfile
import unittest
from pathlib import Path

from drive_sync.config import parse
from drive_sync.report import (conflict_files, report, skipped_at_root, skipped_names,
                               unlisted_folders)

CONFLICT = "x.sync-conflict-20261017-101010-ABCDEFG.txt"


def run_report(layout, device_name):
    messages = []
    report(layout, device_name, messages.append)
    return messages


class UnlistedTest(unittest.TestCase):
    def test_reports_only_unknown_top_level_folders(self):
        with tempfile.TemporaryDirectory() as root:
            for name in ("Pictures", "Games", "lost+found", ".Trash-1000"):
                Path(root, name).mkdir()
            Path(root, "notes.txt").write_text("a file, not a folder")
            self.assertEqual(unlisted_folders(Path(root), {"Pictures"}), ["Games"])


class ConflictTest(unittest.TestCase):
    def test_finds_conflicts_and_skips_ignored_and_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "repo" / "node_modules").mkdir(parents=True)
            (base / ".stversions").mkdir()
            (base / "repo" / "a.sync-conflict-20261017-101010-ABCDEFG.txt").write_text("x")
            (base / "repo" / "node_modules" / "b.sync-conflict-20261017-101010-ABCDEFG.js").write_text("x")
            (base / ".stversions" / "c.sync-conflict-20261017-101010-ABCDEFG.txt").write_text("x")
            found = conflict_files(base, {"node_modules"})
            self.assertEqual([p.name for p in found], ["a.sync-conflict-20261017-101010-ABCDEFG.txt"])

    def test_a_root_pattern_skips_only_at_the_top(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "GitHub").mkdir()
            (base / "Notes" / "GitHub").mkdir(parents=True)
            (base / "GitHub" / CONFLICT).write_text("x")
            (base / "Notes" / "GitHub" / CONFLICT).write_text("x")
            found = conflict_files(base, set(), {"GitHub"})
            self.assertEqual(found, [base / "Notes" / "GitHub" / CONFLICT])

    def test_skipped_names_come_from_plain_patterns(self):
        self.assertEqual(skipped_names(("(?d)node_modules", "build", "*.log", "/dist")), {"node_modules", "build"})

    def test_skipped_at_root_comes_from_anchored_names(self):
        patterns = ("/GitHub", "(?d)/Virtual Machines", "/order*.txt", "/a/b", "!/kept", "build")
        self.assertEqual(skipped_at_root(patterns), {"GitHub", "Virtual Machines"})


class ReportTest(unittest.TestCase):
    def test_reports_unlisted_and_conflicts(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "Games").mkdir()
            Path(root, "Pictures").mkdir()
            Path(root, "Pictures", CONFLICT).write_text("x")
            layout = parse({
                "devices": {"p53": {"id": "P53-ID", "root": root}},
                "folders": {"Pictures": {"category": "synced"}},
            })
            messages = run_report(layout, "p53")
            self.assertTrue(any("Games" in m and "no category" in m for m in messages))
            self.assertTrue(any(CONFLICT in m for m in messages))

    def test_nested_and_not_synced_folders_count_as_listed(self):
        with tempfile.TemporaryDirectory() as root:
            for name in ("Documents", "kopia", "Backups"):
                Path(root, name).mkdir()
            layout = parse({
                "devices": {"array": {"id": "ARRAY-ID", "role": "archive", "root": root,
                                      "not_synced": ["kopia", "Backups"]}},
                "folders": {"Documents/GitHub": {"category": "synced"}},
            })
            self.assertEqual(run_report(layout, "array"), [])

    def test_a_conflict_in_a_nested_folder_is_listed_once(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "Documents", "GitHub").mkdir(parents=True)
            Path(root, "Documents", "GitHub", CONFLICT).write_text("x")
            layout = parse({
                "devices": {"p53": {"id": "P53-ID", "root": root}},
                "folders": {"Documents": {"category": "synced", "ignore": ["/GitHub"]},
                            "Documents/GitHub": {"category": "synced"}},
            })
            self.assertEqual(len([m for m in run_report(layout, "p53") if CONFLICT in m]), 1)

    def test_names_the_place_under_the_root_of_a_folder_kept_elsewhere(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as elsewhere:
            Path(root, "Desktop").mkdir()
            layout = parse({
                "devices": {"pc": {"id": "PC-ID", "root": root, "paths": {"Desktop": elsewhere}}},
                "folders": {"Desktop": {"category": "synced"}},
            })
            messages = run_report(layout, "pc")
            self.assertEqual(len(messages), 1)
            self.assertIn(f"{Path(root, 'Desktop')} is not synced", messages[0])
            self.assertIn(elsewhere, messages[0])


if __name__ == "__main__":
    unittest.main()
