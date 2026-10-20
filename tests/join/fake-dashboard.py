"""A storage dashboard that answers POST /api/join as the contract says, for the join script's tests.

It admits the caller into a real Syncthing (the "storage" peer), shares two folders with it and
answers with that peer, as the real dashboard does. A name in REFUSED gets 403, a name it knows
with another device ID gets 409. Every request is appended to requests.jsonl in the state folder.
"""
import json
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

REFUSED = {"stranger"}
FOLDERS = [
    {"id": "documents", "path": "Documents", "type": "sendreceive"},
    {"id": "documents-github", "path": "Documents/GitHub", "type": "sendreceive"},
]


class Peer:
    def __init__(self, url: str, api_key: str, address: str, caller_address: str, folder_root: str):
        self.url, self.api_key, self.address = url, api_key, address
        self.caller_address, self.folder_root = caller_address, folder_root

    def request(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers={"X-API-Key": self.api_key, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as response:
            text = response.read()
        return json.loads(text) if text else None

    def device_id(self) -> str:
        return self.request("GET", "/rest/system/status")["myID"]

    def admit(self, name: str, device_id: str) -> None:
        self.request("PUT", f"/rest/config/devices/{device_id}",
                     {"deviceID": device_id, "name": name, "addresses": [self.caller_address]})
        for folder in FOLDERS:
            self.request("PUT", f"/rest/config/folders/{folder['id']}", {
                "id": folder["id"], "label": folder["id"], "path": f"{self.folder_root}/{folder['path']}", "type": folder["type"],
                "devices": [{"deviceID": device_id}],
            })


def handler_for(peer: Peer, state: Path, known: dict):
    class Handler(BaseHTTPRequestHandler):
        def answer(self, status: int, body: dict) -> None:
            text = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(text)))
            self.end_headers()
            self.wfile.write(text)

        def do_POST(self):
            if self.path != "/api/join":
                return self.answer(404, {"error": "not found"})
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            with open(state / "requests.jsonl", "a") as log:
                log.write(json.dumps(body) + "\n")
            missing = [key for key in ("name", "os", "syncthingDeviceId", "nodes") if key not in body]
            if missing:
                return self.answer(400, {"error": f"missing {', '.join(missing)}"})
            name, device_id = body["name"], body["syncthingDeviceId"]
            if name in REFUSED:
                return self.answer(403, {"error": "not in this tailnet"})
            if known.get(name, device_id) != device_id:
                return self.answer(409, {"error": f"{name} is known with another device ID"})
            known[name] = device_id
            peer.admit(name, device_id)
            return self.answer(200, {
                "devices": [{"name": "storage", "syncthingDeviceId": peer.device_id(), "addresses": [peer.address]}],
                "folders": FOLDERS,
            })

        def log_message(self, *arguments):
            pass

    return Handler


def main(port: int, peer_url: str, peer_key: str, peer_address: str, state_folder: str,
         caller_address: str = "tcp://127.0.0.1:22000", folder_root: str = "/peer") -> None:
    state = Path(state_folder)
    state.mkdir(parents=True, exist_ok=True)
    known = {"taken": "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA"}
    server = HTTPServer(("127.0.0.1", port), handler_for(Peer(peer_url, peer_key, peer_address, caller_address, folder_root), state, known))
    server.serve_forever()


if __name__ == "__main__":
    main(int(sys.argv[1]), *sys.argv[2:])
