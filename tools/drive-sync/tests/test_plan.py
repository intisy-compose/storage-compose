import unittest
from pathlib import Path

from drive_sync.config import ConfigError, load, parse
from drive_sync.plan import check_nesting, folder_path, plan_for

LAYOUT = parse({
    "devices": {
        "pc": {"id": "PC-ID", "root": "F:\\", "paths": {"Desktop": "C:\\Users\\finn\\Desktop"}},
        "p53": {"id": "P53-ID"},
        "array": {"id": "ARRAY-ID", "role": "archive", "root": "/mnt/storage/pool"},
    },
    "folders": {
        "Documents/GitHub": {"category": "synced", "ignore": ["(?d)node_modules"], "versions_days": 30},
        "Desktop": {"category": "synced"},
        "Program Installers": {"category": "archive"},
        "spisor-sites": {"category": "local"},
    },
})

LIST = Path(__file__).resolve().parent / "fixtures" / "drive-sync.toml"


def by_id(device_name):
    return {plan.id: plan for plan in plan_for(LAYOUT, device_name)}


def path_on(device_name, relative_path):
    return folder_path(LAYOUT.devices[device_name], LAYOUT.folders[relative_path])


class PathTest(unittest.TestCase):
    def test_the_same_relative_path_on_every_device(self):
        self.assertEqual(path_on("p53", "Documents/GitHub"), "/data/Documents/GitHub")
        self.assertEqual(path_on("pc", "Documents/GitHub"), "F:\\Documents\\GitHub")
        self.assertEqual(path_on("array", "Documents/GitHub"), "/mnt/storage/pool/Documents/GitHub")

    def test_archive_folders_sit_at_the_same_place_on_the_array(self):
        self.assertEqual(path_on("array", "Program Installers"), "/mnt/storage/pool/Program Installers")

    def test_a_device_override_wins(self):
        self.assertEqual(path_on("pc", "Desktop"), "C:\\Users\\finn\\Desktop")
        self.assertEqual(path_on("p53", "Desktop"), "/data/Desktop")


class PlanTest(unittest.TestCase):
    def test_local_folders_are_left_out(self):
        self.assertNotIn("spisor-sites", by_id("p53"))

    def test_id_and_label_come_from_the_relative_path(self):
        plan = by_id("pc")["documents-github"]
        self.assertEqual(plan.label, "Documents/GitHub")
        self.assertEqual(plan.path, "F:\\Documents\\GitHub")

    def test_synced_is_send_receive_everywhere(self):
        for device in ("pc", "p53", "array"):
            code = by_id(device)["documents-github"]
            self.assertEqual(code.type, "sendreceive")
            self.assertEqual(code.versions_days, 30)
            self.assertFalse(code.ignore_delete)

    def test_archive_is_send_only_on_devices_without_versions(self):
        installers = by_id("p53")["program-installers"]
        self.assertEqual(installers.type, "sendonly")
        self.assertIsNone(installers.versions_days)
        self.assertFalse(installers.ignore_delete)

    def test_archive_is_receive_only_and_keeps_deletes_on_the_array(self):
        installers = by_id("array")["program-installers"]
        self.assertEqual(installers.type, "receiveonly")
        self.assertTrue(installers.ignore_delete)
        self.assertEqual(installers.versions_days, 365)

    def test_every_folder_is_shared_with_every_device(self):
        self.assertEqual(by_id("pc")["program-installers"].devices, ("ARRAY-ID", "P53-ID", "PC-ID"))

    def test_ignore_patterns_travel_with_the_folder(self):
        self.assertEqual(by_id("p53")["documents-github"].ignore, ("(?d)node_modules",))


class NotJoinedTest(unittest.TestCase):
    def test_a_device_not_yet_joined_is_left_out_of_every_share(self):
        layout = parse({
            "devices": {"p53": {"id": "P53-ID"}, "array": {"id": "ARRAY-ID", "role": "archive", "joined": False}},
            "folders": {"Pictures": {"category": "synced"}},
        })
        self.assertEqual(plan_for(layout, "p53")[0].devices, ("P53-ID",))

    def test_a_device_always_shares_with_itself(self):
        layout = parse({
            "devices": {"pc": {"id": "PC-ID", "joined": False}, "p53": {"id": "P53-ID"}},
            "folders": {"Pictures": {"category": "synced"}},
        })
        self.assertEqual(plan_for(layout, "pc")[0].devices, ("P53-ID", "PC-ID"))


def nested_layout(documents_ignore):
    return parse({
        "devices": {"pc": {"id": "PC-ID", "root": "F:\\"}, "p53": {"id": "P53-ID"}},
        "folders": {
            "Documents": {"category": "synced", "ignore": documents_ignore},
            "Documents/GitHub": {"category": "synced"},
            "Documents/Virtual Machines": {"category": "local"},
        },
    })


class NestingTest(unittest.TestCase):
    def test_a_folder_inside_another_is_refused_on_every_device(self):
        for device in ("pc", "p53"):
            with self.subTest(device=device), \
                    self.assertRaisesRegex(ConfigError, 'Documents/GitHub .* lies inside Documents.*"/GitHub"'):
                check_nesting(nested_layout(["/Virtual Machines"]), device)

    def test_a_local_folder_inside_a_shared_one_is_refused(self):
        with self.assertRaisesRegex(ConfigError, "Documents/Virtual Machines .* lies inside Documents"):
            check_nesting(nested_layout(["/GitHub"]), "p53")

    def test_nesting_is_fine_when_the_outer_folder_ignores_it(self):
        check_nesting(nested_layout(["/GitHub", "(?d)/Virtual Machines"]), "pc")

    def test_windows_paths_compare_without_case(self):
        layout = parse({
            "devices": {"pc": {"id": "PC-ID", "root": "F:\\", "paths": {"Pictures": "f:\\documents\\Pictures"}}},
            "folders": {"Pictures": {"category": "synced"}, "Documents": {"category": "synced"}},
        })
        with self.assertRaises(ConfigError):
            check_nesting(layout, "pc")

    def test_a_full_list_nests_cleanly_on_every_device(self):
        layout = load(LIST)
        for device_name in layout.devices:
            check_nesting(layout, device_name)


if __name__ == "__main__":
    unittest.main()
