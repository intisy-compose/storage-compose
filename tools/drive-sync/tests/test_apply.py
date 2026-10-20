import unittest

from drive_sync.apply import apply_layout, folder_config
from drive_sync.config import parse
from drive_sync.plan import plan_for
from drive_sync.syncthing import SyncthingError

LAYOUT = parse({
    "devices": {
        "p53": {"id": "P53-ID"},
        "array": {"id": "ARRAY-ID", "role": "archive", "root": "/pool", "address": "tcp://array:22000"},
    },
    "folders": {
        "Documents/GitHub": {"category": "synced", "ignore": ["(?d)node_modules"], "versions_days": 30},
        "Videos": {"category": "archive"},
        "spisor-sites": {"category": "local"},
    },
})

CODE = "documents-github"


class FakeClient:
    def __init__(self, folders=None, devices=None, ignore_failures=0):
        self.folders = dict(folders or {})
        self.devices = dict(devices or {})
        self.ignores = {}
        self.ignore_failures = ignore_failures
        self.events = []

    def default_folder(self):
        return {"id": "", "path": "", "rescanIntervalS": 3600, "fsWatcherEnabled": True}

    def folder(self, folder_id):
        return self.folders.get(folder_id)

    def put_folder(self, folder):
        self.folders[folder["id"]] = folder
        self.events.append(("put_folder", folder["id"], folder.get("paused", False)))

    def device(self, device_id):
        return self.devices.get(device_id)

    def put_device(self, device):
        self.devices[device["deviceID"]] = device

    def set_ignores(self, folder_id, lines):
        if self.ignore_failures:
            self.ignore_failures -= 1
            raise SyncthingError("POST /rest/db/ignores: 500 folder not running")
        self.ignores[folder_id] = list(lines)
        self.events.append(("set_ignores", folder_id, self.folders[folder_id].get("paused", False)))


def quiet(message):
    pass


class FolderConfigTest(unittest.TestCase):
    def test_keeps_base_fields_and_sets_the_plan(self):
        plan = {p.id: p for p in plan_for(LAYOUT, "array")}["videos"]
        folder = folder_config({"rescanIntervalS": 60, "label": "old"}, plan)
        self.assertEqual(folder["rescanIntervalS"], 60)
        self.assertEqual(folder["label"], "Videos")
        self.assertEqual(folder["type"], "receiveonly")
        self.assertTrue(folder["ignoreDelete"])
        self.assertEqual(folder["devices"], [{"deviceID": "ARRAY-ID"}, {"deviceID": "P53-ID"}])
        self.assertEqual(folder["versioning"]["type"], "staggered")
        self.assertEqual(folder["versioning"]["params"]["maxAge"], str(365 * 86400))

    def test_send_only_has_no_versioning(self):
        plan = {p.id: p for p in plan_for(LAYOUT, "p53")}["videos"]
        self.assertEqual(folder_config({}, plan)["versioning"], {"type": "", "params": {}})


class ApplyTest(unittest.TestCase):
    def test_adds_other_devices_but_not_itself(self):
        client = FakeClient()
        apply_layout(client, LAYOUT, "p53", quiet)
        self.assertEqual(set(client.devices), {"ARRAY-ID"})
        self.assertEqual(client.devices["ARRAY-ID"]["addresses"], ["tcp://array:22000"])
        self.assertEqual(client.devices["ARRAY-ID"]["name"], "array")

    def test_keeps_fields_of_a_known_device(self):
        client = FakeClient(devices={"ARRAY-ID": {"deviceID": "ARRAY-ID", "compression": "always"}})
        apply_layout(client, LAYOUT, "p53", quiet)
        self.assertEqual(client.devices["ARRAY-ID"]["compression"], "always")

    def test_creates_folders_from_the_defaults_and_skips_local(self):
        client = FakeClient()
        apply_layout(client, LAYOUT, "p53", quiet)
        self.assertEqual(set(client.folders), {CODE, "videos"})
        self.assertEqual(client.folders[CODE]["path"], "/data/Documents/GitHub")
        self.assertEqual(client.folders[CODE]["rescanIntervalS"], 3600)
        self.assertEqual(client.ignores[CODE], ["(?d)node_modules"])

    def test_a_second_run_changes_nothing(self):
        client = FakeClient()
        apply_layout(client, LAYOUT, "p53", quiet)
        first = ({k: dict(v) for k, v in client.folders.items()}, dict(client.devices))
        apply_layout(client, LAYOUT, "p53", quiet)
        self.assertEqual(({k: dict(v) for k, v in client.folders.items()}, dict(client.devices)), first)

    def test_never_moves_an_existing_folder(self):
        client = FakeClient(folders={CODE: {"id": CODE, "path": "/old/code", "type": "sendreceive"}})
        messages = []
        apply_layout(client, LAYOUT, "p53", messages.append)
        self.assertEqual(client.folders[CODE]["path"], "/old/code")
        self.assertTrue(any(CODE in m and "/old/code" in m and "/data/Documents/GitHub" in m for m in messages))

    def test_a_new_folder_gets_its_ignores_while_paused_then_starts(self):
        client = FakeClient()
        apply_layout(client, LAYOUT, "p53", quiet)
        code_events = [event for event in client.events if event[1] == CODE]
        self.assertEqual(code_events, [("put_folder", CODE, True), ("set_ignores", CODE, True),
                                       ("put_folder", CODE, False)])

    def test_an_existing_folder_keeps_its_paused_state(self):
        client = FakeClient(folders={CODE: {"id": CODE, "path": "/data/Documents/GitHub", "paused": True}})
        apply_layout(client, LAYOUT, "p53", quiet)
        self.assertTrue(client.folders[CODE]["paused"])

    def test_keeps_devices_a_folder_already_shares_with(self):
        other = {"deviceID": "OTHER-ID", "encryptionPassword": "secret"}
        client = FakeClient(folders={CODE: {"id": CODE, "path": "/data/Documents/GitHub", "devices": [other]}})
        apply_layout(client, LAYOUT, "p53", quiet)
        self.assertEqual(client.folders[CODE]["devices"],
                         [other, {"deviceID": "ARRAY-ID"}, {"deviceID": "P53-ID"}])

    def test_skips_devices_not_yet_joined(self):
        layout = parse({
            "devices": {"p53": {"id": "P53-ID"}, "array": {"id": "ARRAY-ID-AFTER-INSTALL", "joined": False}},
            "folders": {"code": {"category": "synced"}},
        })
        client = FakeClient()
        apply_layout(client, layout, "p53", quiet)
        self.assertEqual(client.devices, {})

    def test_retries_ignores_while_a_new_folder_starts(self):
        client = FakeClient(ignore_failures=2)
        apply_layout(client, LAYOUT, "p53", quiet, retry_delay_seconds=0)
        self.assertEqual(client.ignores[CODE], ["(?d)node_modules"])


if __name__ == "__main__":
    unittest.main()
