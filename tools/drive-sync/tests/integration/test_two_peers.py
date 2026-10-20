import os
import shutil
import subprocess
import time
import unittest
from pathlib import Path

from drive_sync.apply import apply_layout
from drive_sync.config import parse
from drive_sync.report import conflict_files
from drive_sync.syncthing import Client, SyncthingError

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
COMPOSE = ["docker", "compose", "-f", str(HERE / "compose.yml")]
TIMEOUT_SECONDS = 120
CODE = "documents-github"


def wait_until(condition, what):
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            if condition():
                return
        except SyncthingError:
            pass
        time.sleep(1)
    raise AssertionError(f"timed out waiting for {what}")


@unittest.skipUnless(os.environ.get("DRIVE_SYNC_INTEGRATION") == "1", "set DRIVE_SYNC_INTEGRATION=1, needs Docker")
class TwoPeersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        shutil.rmtree(WORK, ignore_errors=True)
        (WORK / "alpha").mkdir(parents=True)
        (WORK / "beta").mkdir()
        subprocess.run([*COMPOSE, "up", "-d"], check=True)
        cls.alpha = Client("http://127.0.0.1:18384", "alpha-test-key")
        cls.beta = Client("http://127.0.0.1:28384", "beta-test-key")
        wait_until(lambda: cls.alpha.my_id() and cls.beta.my_id(), "both APIs")
        cls.layout = parse({
            "devices": {
                "alpha": {"id": cls.alpha.my_id(), "address": "tcp://alpha:22000"},
                "beta": {"id": cls.beta.my_id(), "role": "archive", "address": "tcp://beta:22000"},
            },
            "folders": {
                "Documents": {"category": "synced", "ignore": ["/GitHub", "/Virtual Machines"]},
                "Documents/GitHub": {"category": "synced", "versions_days": 30,
                                     "ignore": ["!/vendored/dist/**", "(?d)node_modules", "(?d)dist"]},
                "Documents/Virtual Machines": {"category": "local"},
                "Videos": {"category": "archive"},
            },
        })
        apply_layout(cls.alpha, cls.layout, "alpha", print)
        apply_layout(cls.beta, cls.layout, "beta", print)

    @classmethod
    def tearDownClass(cls):
        subprocess.run([*COMPOSE, "down", "-v"], check=False)
        shutil.rmtree(WORK, ignore_errors=True)

    def write(self, side, relative, text):
        path = WORK / side / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def rescan(self, client, folder):
        """@implNote File watchers do not see changes made through a Windows bind mount."""
        client.scan(folder)

    def arrive(self, relative_on_beta, what):
        wait_until(lambda: (WORK / "beta" / relative_on_beta).exists(), what)

    def test_folder_types(self):
        self.assertEqual(self.alpha.folder("documents")["type"], "sendreceive")
        self.assertEqual(self.alpha.folder("videos")["type"], "sendonly")
        self.assertEqual(self.beta.folder("videos")["type"], "receiveonly")
        self.assertTrue(self.beta.folder("videos")["ignoreDelete"])
        self.assertEqual(self.beta.folder("documents-github")["path"], "/data/Documents/GitHub")
        self.assertIsNone(self.alpha.folder("documents-virtual-machines"))

    def test_synced_file_reaches_the_other_side(self):
        self.write("alpha", "Documents/hello.txt", "hello")
        self.rescan(self.alpha, "documents")
        self.arrive("Documents/hello.txt", "the synced file on beta")

    def test_archive_keeps_what_a_device_deletes(self):
        video = self.write("alpha", "Videos/clip.bin", "frames")
        self.rescan(self.alpha, "videos")
        self.arrive("Videos/clip.bin", "the archived file on beta")
        video.unlink()
        self.rescan(self.alpha, "videos")
        self.write("alpha", "Videos/after-delete.bin", "marker")
        self.rescan(self.alpha, "videos")
        self.arrive("Videos/after-delete.bin", "the marker sent after the delete")
        self.assertTrue((WORK / "beta" / "Videos/clip.bin").exists())

    def test_send_only_never_downloads(self):
        self.write("beta", "Videos/only-on-beta.bin", "beta")
        self.rescan(self.beta, "videos")
        self.write("alpha", "Videos/marker.bin", "marker")
        self.rescan(self.alpha, "videos")
        self.arrive("Videos/marker.bin", "the marker on beta")
        time.sleep(5)
        self.assertFalse((WORK / "alpha" / "Videos/only-on-beta.bin").exists())

    def test_ignored_build_output_stays_local(self):
        self.write("alpha", "Documents/GitHub/repo/node_modules/dependency.js", "dependency")
        self.write("alpha", "Documents/GitHub/repo/main.js", "main")
        self.rescan(self.alpha, CODE)
        self.arrive("Documents/GitHub/repo/main.js", "the source file on beta")
        self.assertFalse((WORK / "beta" / "Documents/GitHub/repo/node_modules").exists())

    def test_tracked_folder_with_a_build_name_still_syncs(self):
        self.write("alpha", "Documents/GitHub/vendored/dist/bundle.js", "tracked in git")
        self.write("alpha", "Documents/GitHub/app/dist/bundle.js", "build output")
        self.write("alpha", "Documents/GitHub/app/marker.js", "marker")
        self.rescan(self.alpha, CODE)
        self.arrive("Documents/GitHub/app/marker.js", "the marker on beta")
        self.arrive("Documents/GitHub/vendored/dist/bundle.js", "the excepted dist folder on beta")
        self.assertFalse((WORK / "beta" / "Documents/GitHub/app/dist").exists())

    def test_a_local_folder_inside_a_synced_one_stays_local(self):
        self.write("alpha", "Documents/Virtual Machines/disk.vmdk", "disk")
        self.write("alpha", "Documents/after-vm.txt", "marker")
        self.rescan(self.alpha, "documents")
        self.arrive("Documents/after-vm.txt", "the marker on beta")
        self.assertFalse((WORK / "beta" / "Documents/Virtual Machines").exists())

    def test_conflicting_edits_leave_a_conflict_file(self):
        self.write("alpha", "Documents/shared.txt", "first")
        self.rescan(self.alpha, "documents")
        self.arrive("Documents/shared.txt", "the shared file on beta")
        beta_id, alpha_id = self.beta.my_id(), self.alpha.my_id()
        self.alpha.pause(beta_id)
        self.beta.pause(alpha_id)
        self.write("alpha", "Documents/shared.txt", "edited on alpha")
        self.write("beta", "Documents/shared.txt", "edited on beta")
        self.rescan(self.alpha, "documents")
        self.rescan(self.beta, "documents")
        self.alpha.resume(beta_id)
        self.beta.resume(alpha_id)
        sides = [WORK / "alpha" / "Documents", WORK / "beta" / "Documents"]
        wait_until(lambda: any(conflict_files(side, set()) for side in sides), "a conflict file")


if __name__ == "__main__":
    unittest.main()
