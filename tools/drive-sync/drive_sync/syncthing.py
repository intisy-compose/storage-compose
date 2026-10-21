import json
import os
import ssl
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from urllib.parse import quote

REQUEST_TIMEOUT_SECONDS = 30


class SyncthingError(Exception):
    pass


def default_homes() -> list[Path]:
    if sys.platform == "win32":
        return [Path(os.environ.get("LOCALAPPDATA", "")) / "Syncthing"]
    return [Path.home() / ".local/state/syncthing", Path.home() / ".config/syncthing"]


def find_endpoint(home: Path | None) -> tuple[str, str]:
    for candidate in [home] if home else default_homes():
        config = candidate / "config.xml"
        if config.exists():
            gui = ElementTree.parse(config).getroot().find("gui")
            scheme = "https" if gui.get("tls") == "true" else "http"
            return f"{scheme}://{gui.findtext('address')}", gui.findtext("apikey")
    raise SyncthingError("no Syncthing config.xml found; pass --syncthing-home, or --api-url and --api-key")


def _local_tls_context() -> ssl.SSLContext:
    """@implNote Syncthing's GUI certificate is self-signed, and the API is only reached locally."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


class Client:
    def __init__(self, url: str, api_key: str):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self._context = _local_tls_context() if self.url.startswith("https") else None

    def _request(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.url + path, data=data, method=method,
            headers={"X-API-Key": self.api_key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS, context=self._context) as response:
                text = response.read()
        except urllib.error.HTTPError as error:
            with error:
                if error.code == 404 and method == "GET":
                    return None
                detail = error.read().decode(errors="replace").strip()
            raise SyncthingError(f"{method} {path}: {error.code} {detail}") from error
        except (urllib.error.URLError, OSError) as error:
            raise SyncthingError(f"{method} {path}: {getattr(error, 'reason', error)}") from error
        return json.loads(text) if text else None

    def my_id(self) -> str:
        return self._request("GET", "/rest/system/status")["myID"]

    def folder(self, folder_id: str) -> dict | None:
        return self._request("GET", f"/rest/config/folders/{quote(folder_id)}")

    def default_folder(self) -> dict:
        return self._request("GET", "/rest/config/defaults/folder")

    def put_folder(self, folder: dict) -> None:
        self._request("PUT", f"/rest/config/folders/{quote(folder['id'])}", folder)

    def device(self, device_id: str) -> dict | None:
        return self._request("GET", f"/rest/config/devices/{quote(device_id)}")

    def put_device(self, device: dict) -> None:
        self._request("PUT", f"/rest/config/devices/{quote(device['deviceID'])}", device)

    def set_ignores(self, folder_id: str, lines) -> None:
        self._request("POST", f"/rest/db/ignores?folder={quote(folder_id)}", {"ignore": list(lines)})

    def scan(self, folder_id: str) -> None:
        self._request("POST", f"/rest/db/scan?folder={quote(folder_id)}")

    def pause(self, device_id: str) -> None:
        self._request("POST", f"/rest/system/pause?device={quote(device_id)}")

    def resume(self, device_id: str) -> None:
        self._request("POST", f"/rest/system/resume?device={quote(device_id)}")
