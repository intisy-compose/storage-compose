import unittest
from pathlib import Path

from drive_sync.config import ConfigError, folder_id, load, parse

VALID = {
    "devices": {
        "pc": {"id": "PC-ID", "root": "F:\\", "paths": {"Desktop": "C:\\Users\\finn\\Desktop"},
               "not_synced": ["$RECYCLE.BIN"]},
        "array": {"id": "ARRAY-ID", "role": "archive", "root": "/mnt/storage/pool",
                  "address": "tcp://storage.example.ts.net:22000"},
    },
    "folders": {
        "Documents/GitHub": {"category": "synced", "ignore": ["(?d)node_modules"], "versions_days": 30},
        "Documents": {"category": "synced", "ignore": ["/GitHub"]},
        "Desktop": {"category": "synced"},
        "Videos": {"category": "archive"},
        "spisor-sites": {"category": "local"},
    },
}

LIST = Path(__file__).resolve().parent / "fixtures" / "drive-sync.toml"


def with_changes(**sections):
    data = {key: {name: dict(entry) for name, entry in value.items()} for key, value in VALID.items()}
    for key, value in sections.items():
        data[key] = value
    return data


class ParseTest(unittest.TestCase):
    def test_reads_devices_with_defaults(self):
        layout = parse(VALID)
        self.assertEqual(layout.devices["pc"].role, "device")
        self.assertEqual(layout.devices["pc"].address, "dynamic")
        self.assertEqual(layout.devices["pc"].paths, {"Desktop": "C:\\Users\\finn\\Desktop"})
        self.assertEqual(layout.devices["pc"].not_synced, ("$RECYCLE.BIN",))
        self.assertEqual(layout.devices["array"].root, "/mnt/storage/pool")
        self.assertEqual(layout.devices["array"].paths, {})
        self.assertEqual(layout.devices["array"].not_synced, ())

    def test_root_defaults_to_data(self):
        layout = parse(with_changes(devices={"p53": {"id": "P53-ID"}}))
        self.assertEqual(layout.devices["p53"].root, "/data")

    def test_reads_folders_with_defaults(self):
        layout = parse(VALID)
        self.assertEqual(layout.folders["Documents/GitHub"].ignore, ("(?d)node_modules",))
        self.assertEqual(layout.folders["Documents/GitHub"].versions_days, 30)
        self.assertEqual(layout.folders["Desktop"].versions_days, 365)
        self.assertEqual(layout.folders["Desktop"].ignore, ())

    def test_a_folder_id_comes_from_its_relative_path(self):
        layout = parse(VALID)
        self.assertEqual(layout.folders["Documents/GitHub"].id, "documents-github")
        self.assertEqual(layout.folders["spisor-sites"].id, "spisor-sites")
        self.assertEqual(folder_id("Program Installers"), "program-installers")
        self.assertEqual(folder_id("Documents/Virtual Machines"), "documents-virtual-machines")

    def test_top_level_is_the_first_part_of_the_path(self):
        self.assertEqual(parse(VALID).folders["Documents/GitHub"].top_level, "Documents")

    def test_devices_are_joined_unless_marked(self):
        layout = parse(with_changes(devices={"pc": {"id": "PC-ID"}, "p53": {"id": "P53-ID", "joined": False}}))
        self.assertTrue(layout.devices["pc"].joined)
        self.assertFalse(layout.devices["p53"].joined)

    def test_rejects_unknown_category(self):
        with self.assertRaisesRegex(ConfigError, 'folders."Music": category'):
            parse(with_changes(folders={"Music": {"category": "sometimes"}}))

    def test_rejects_unknown_role(self):
        with self.assertRaisesRegex(ConfigError, "devices.pc: role"):
            parse(with_changes(devices={"pc": {"id": "X", "role": "server"}}))

    def test_rejects_missing_id(self):
        with self.assertRaisesRegex(ConfigError, "devices.pc: id is missing"):
            parse(with_changes(devices={"pc": {"id": ""}}))

    def test_rejects_bad_device_names(self):
        with self.assertRaisesRegex(ConfigError, "device name 'My PC'"):
            parse(with_changes(devices={"My PC": {"id": "X"}}))

    def test_rejects_folder_names_that_are_not_relative_paths(self):
        for name in ("/Videos", "Documents/", "Documents\\GitHub", "Documents//GitHub", "../Videos", "$$"):
            with self.subTest(name=name), self.assertRaises(ConfigError):
                parse(with_changes(folders={name: {"category": "archive"}}))

    def test_rejects_two_folders_with_one_id(self):
        with self.assertRaisesRegex(ConfigError, "both get the folder ID minecraft-server"):
            parse(with_changes(folders={"Minecraft Server": {"category": "archive"},
                                        "minecraft-server": {"category": "archive"}}))

    def test_rejects_paths_for_an_unknown_folder(self):
        with self.assertRaisesRegex(ConfigError, 'devices.pc.paths."Games": no such folder'):
            parse(with_changes(devices={"pc": {"id": "PC-ID", "paths": {"Games": "F:\\Games"}}}))

    def test_rejects_the_old_paths_section(self):
        with self.assertRaisesRegex(ConfigError, "unknown section 'paths'"):
            parse(with_changes(paths={"pc": {}}))

    def test_rejects_bad_versions(self):
        with self.assertRaisesRegex(ConfigError, 'folders."Videos": versions_days'):
            parse(with_changes(folders={"Videos": {"category": "archive", "versions_days": 0}}))

    def test_rejects_empty_list(self):
        with self.assertRaisesRegex(ConfigError, "no devices"):
            parse({"folders": {}})


class ListTest(unittest.TestCase):
    """@implNote Syncthing pairs folders across devices by ID, so these must never change once a
    device has joined."""

    def test_folder_ids_stay_as_published(self):
        ids = {folder.relative_path: folder.id for folder in load(LIST).folders.values()}
        self.assertEqual(ids, {
            "Documents": "documents",
            "Documents/GitHub": "documents-github",
            "Documents/Backup": "documents-backup",
            "Documents/Virtual Machines": "documents-virtual-machines",
            "Pictures": "pictures",
            "Desktop": "desktop",
            "Videos": "videos",
            "Program Installers": "program-installers",
            "Backup-Old": "backup-old",
            "sites": "sites",
        })


if __name__ == "__main__":
    unittest.main()
