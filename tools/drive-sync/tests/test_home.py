import os
import tempfile
import unittest
from pathlib import Path

from drive_sync.config import parse
from drive_sync.home import HomeConflict, link_home, link_homes


def can_symlink() -> bool:
    with tempfile.TemporaryDirectory() as scratch:
        try:
            os.symlink(scratch, Path(scratch, "probe"))
            return True
        except OSError:
            return False


@unittest.skipUnless(can_symlink(), "needs symlinks (Linux, or Windows with Developer Mode)")
class LinkHomeTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        base = Path(self.scratch.name)
        self.target = base / "data" / "Documents"
        self.link = base / "home" / "Documents"
        self.link.parent.mkdir()

    def tearDown(self):
        self.scratch.cleanup()

    def test_creates_link_and_target(self):
        self.assertEqual(link_home(self.target, self.link), "linked")
        self.assertTrue(self.link.is_symlink())
        self.assertTrue(self.target.is_dir())

    def test_correct_link_is_left_alone(self):
        link_home(self.target, self.link)
        self.assertEqual(link_home(self.target, self.link), "ok")

    def test_moves_files_in_then_links(self):
        self.link.mkdir()
        (self.link / "cv.pdf").write_text("cv")
        self.assertEqual(link_home(self.target, self.link), "linked, 1 entries moved")
        self.assertEqual((self.target / "cv.pdf").read_text(), "cv")
        self.assertTrue(self.link.is_symlink())

    def test_refuses_to_overwrite_and_moves_nothing(self):
        self.link.mkdir()
        (self.link / "cv.pdf").write_text("home copy")
        (self.link / "other.txt").write_text("other")
        self.target.mkdir(parents=True)
        (self.target / "cv.pdf").write_text("data copy")
        with self.assertRaisesRegex(HomeConflict, "cv.pdf"):
            link_home(self.target, self.link)
        self.assertEqual((self.target / "cv.pdf").read_text(), "data copy")
        self.assertTrue((self.link / "other.txt").exists())
        self.assertFalse(self.link.is_symlink())

    def test_link_elsewhere_is_reported(self):
        elsewhere = Path(self.scratch.name) / "elsewhere"
        elsewhere.mkdir()
        self.link.symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaisesRegex(HomeConflict, "points to"):
            link_home(self.target, self.link)

    def test_broken_link_is_reported(self):
        self.link.symlink_to(Path(self.scratch.name) / "gone", target_is_directory=True)
        with self.assertRaisesRegex(HomeConflict, "points to"):
            link_home(self.target, self.link)

    def test_file_in_the_way_is_reported(self):
        self.link.write_text("not a folder")
        with self.assertRaisesRegex(HomeConflict, "is a file"):
            link_home(self.target, self.link)

    def test_links_only_folders_with_a_home_name(self):
        base = Path(self.scratch.name)
        layout = parse({
            "devices": {"p53": {"id": "P53-ID", "root": str(base / "data")}},
            "folders": {"Documents": {"category": "synced"}, "Documents/GitHub": {"category": "synced"},
                        "spisor-sites": {"category": "local"}},
        })
        messages = []
        link_homes(layout, "p53", base / "home", messages.append)
        self.assertTrue((base / "home" / "Documents").is_symlink())
        self.assertEqual((base / "home" / "code").resolve(), (base / "data" / "Documents" / "GitHub").resolve())
        self.assertFalse((base / "home" / "spisor-sites").exists())
        self.assertEqual(len(messages), 2)


if __name__ == "__main__":
    unittest.main()
