import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from drive_sync.cli import main, own_device
from drive_sync.config import ConfigError, parse

LIST = """
[devices.p53]
id = "P53-ID-LONG"

[folders.Pictures]
category = "synced"
"""


class OwnDeviceTest(unittest.TestCase):
    def test_finds_the_device_by_its_id(self):
        self.assertEqual(own_device(parse({"devices": {"p53": {"id": "P53-ID-LONG"}}}), "P53-ID-LONG"), "p53")

    def test_unknown_id_names_its_start(self):
        with self.assertRaisesRegex(ConfigError, "ABCDEFG"):
            own_device(parse({"devices": {"p53": {"id": "P53-ID-LONG"}}}), "ABCDEFG-HIJKLMN")


class MainTest(unittest.TestCase):
    def run_main(self, *args):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), contextlib.redirect_stdout(io.StringIO()):
            code = main(list(args))
        return code, errors.getvalue()

    def test_unreachable_syncthing_is_one_line_and_exit_1(self):
        with tempfile.TemporaryDirectory() as scratch:
            config = Path(scratch, "drive-sync.toml")
            config.write_text(LIST)
            code, errors = self.run_main("apply", "--config", str(config),
                                         "--api-url", "http://127.0.0.1:9", "--api-key", "k")
        self.assertEqual(code, 1)
        self.assertEqual(len(errors.strip().splitlines()), 1)
        self.assertTrue(errors.startswith("drive-sync: GET /rest/system/status"))

    def test_bad_list_is_one_line_and_exit_1(self):
        with tempfile.TemporaryDirectory() as scratch:
            config = Path(scratch, "drive-sync.toml")
            config.write_text('[folders.Pictures]\ncategory = "maybe"\n')
            code, errors = self.run_main("apply", "--config", str(config),
                                         "--api-url", "http://127.0.0.1:9", "--api-key", "k")
        self.assertEqual(code, 1)
        self.assertIn('folders."Pictures": category', errors)

    def test_nested_folders_stop_before_syncthing_is_touched(self):
        with tempfile.TemporaryDirectory() as scratch:
            config = Path(scratch, "drive-sync.toml")
            config.write_text(LIST + '[folders.Documents]\ncategory = "synced"\n\n'
                              '[folders."Documents/GitHub"]\ncategory = "synced"\n')
            code, errors = self.run_main("apply", "--config", str(config),
                                         "--api-url", "http://127.0.0.1:9", "--api-key", "k")
        self.assertEqual(code, 1)
        self.assertIn("Documents/GitHub at /data/Documents/GitHub lies inside Documents", errors)

    def test_missing_list_file_is_one_line_and_exit_1(self):
        code, errors = self.run_main("apply", "--config", "does-not-exist.toml",
                                     "--api-url", "http://127.0.0.1:9", "--api-key", "k")
        self.assertEqual(code, 1)
        self.assertIn("does-not-exist.toml", errors)


if __name__ == "__main__":
    unittest.main()
