import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from drive_sync.syncthing import Client, SyncthingError, find_endpoint

CONFIG_XML = """<configuration version="37">
    <gui enabled="true" tls="false">
        <address>127.0.0.1:8384</address>
        <apikey>secret-key</apikey>
    </gui>
</configuration>"""


class FakeSyncthing(BaseHTTPRequestHandler):
    requests = []

    def _answer(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        FakeSyncthing.requests.append((self.command, self.path, self.headers.get("X-API-Key"), body))
        if self.path.startswith("/rest/config/folders/missing"):
            self.send_response(404)
            self.end_headers()
            return
        if self.path.startswith("/rest/broken"):
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"exploded")
            return
        payload = {"myID": "MY-ID"} if self.path == "/rest/system/status" else {"id": "x"}
        data = json.dumps(payload).encode() if self.command == "GET" else b""
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_PUT = do_POST = _answer

    def log_message(self, *args):
        pass


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeSyncthing)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.client = Client(f"http://127.0.0.1:{cls.server.server_port}", "secret-key")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeSyncthing.requests.clear()

    def test_sends_the_api_key_and_reads_json(self):
        self.assertEqual(self.client.my_id(), "MY-ID")
        self.assertEqual(FakeSyncthing.requests[0][:3], ("GET", "/rest/system/status", "secret-key"))

    def test_missing_folder_is_none(self):
        self.assertIsNone(self.client.folder("missing"))

    def test_put_sends_the_body(self):
        self.client.put_folder({"id": "code", "type": "sendreceive"})
        self.assertEqual(FakeSyncthing.requests[0][0:2], ("PUT", "/rest/config/folders/code"))
        self.assertEqual(FakeSyncthing.requests[0][3], {"id": "code", "type": "sendreceive"})

    def test_ignores_go_to_the_folder(self):
        self.client.set_ignores("code", ("(?d)node_modules",))
        self.assertEqual(FakeSyncthing.requests[0][1], "/rest/db/ignores?folder=code")
        self.assertEqual(FakeSyncthing.requests[0][3], {"ignore": ["(?d)node_modules"]})

    def test_errors_name_method_and_path(self):
        with self.assertRaisesRegex(SyncthingError, "GET /rest/broken: 500 exploded"):
            self.client._request("GET", "/rest/broken")

    def test_unreachable_is_a_syncthing_error(self):
        with self.assertRaisesRegex(SyncthingError, "GET /rest/system/status"):
            Client("http://127.0.0.1:9", "key").my_id()


class EndpointTest(unittest.TestCase):
    def test_reads_address_and_key_from_config_xml(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, "config.xml").write_text(CONFIG_XML)
            self.assertEqual(find_endpoint(Path(home)), ("http://127.0.0.1:8384", "secret-key"))

    def test_missing_config_says_what_to_pass(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaisesRegex(SyncthingError, "--syncthing-home"):
                find_endpoint(Path(home))


if __name__ == "__main__":
    unittest.main()
