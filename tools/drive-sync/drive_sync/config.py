import re
import tomllib
from dataclasses import dataclass

CATEGORIES = ("synced", "archive", "local")
ROLES = ("device", "archive")
SECTIONS = ("devices", "folders")
DEFAULT_VERSIONS_DAYS = 365
DEVICE_NAME = re.compile(r"[a-z0-9][a-z0-9-]*")
NOT_IN_A_FOLDER_ID = re.compile(r"[^a-z0-9]+")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Device:
    name: str
    id: str
    role: str
    root: str
    address: str
    paths: dict[str, str]
    not_synced: tuple[str, ...]
    joined: bool


@dataclass(frozen=True)
class Folder:
    relative_path: str
    id: str
    category: str
    ignore: tuple[str, ...]
    versions_days: int

    @property
    def top_level(self) -> str:
        return self.relative_path.split("/")[0]


@dataclass(frozen=True)
class Layout:
    devices: dict[str, Device]
    folders: dict[str, Folder]


def load(path) -> Layout:
    with open(path, "rb") as handle:
        return parse(tomllib.load(handle))


def parse(data: dict) -> Layout:
    for section in data:
        if section not in SECTIONS:
            raise ConfigError(f"unknown section '{section}'; the list has only {', '.join(SECTIONS)}")
    folders = {relative: _folder(relative, entry) for relative, entry in data.get("folders", {}).items()}
    _check_unique_ids(folders)
    devices = {name: _device(name, entry, folders) for name, entry in data.get("devices", {}).items()}
    if not devices:
        raise ConfigError("no devices")
    return Layout(devices, folders)


def folder_id(relative_path: str) -> str:
    """@implNote Syncthing matches a folder across devices by this ID, so the derivation is part of
    every device's config: changing it, or a folder's path, makes a new folder."""
    return NOT_IN_A_FOLDER_ID.sub("-", relative_path.lower()).strip("-")


def _check_relative_path(relative_path: str) -> None:
    parts = relative_path.split("/")
    if "\\" in relative_path or any(part in ("", ".", "..") for part in parts):
        raise ConfigError(f"folders.\"{relative_path}\": the name must be a path relative to the device root, "
                          f"with / between its parts")
    if not folder_id(relative_path):
        raise ConfigError(f"folders.\"{relative_path}\": the name needs a letter or digit")


def _check_unique_ids(folders: dict[str, Folder]) -> None:
    seen = {}
    for folder in folders.values():
        if folder.id in seen:
            raise ConfigError(f"folders \"{seen[folder.id]}\" and \"{folder.relative_path}\" "
                              f"both get the folder ID {folder.id}")
        seen[folder.id] = folder.relative_path


def _folder(relative_path: str, entry: dict) -> Folder:
    _check_relative_path(relative_path)
    category = entry.get("category")
    if category not in CATEGORIES:
        raise ConfigError(f"folders.\"{relative_path}\": category must be one of {', '.join(CATEGORIES)}")
    versions_days = entry.get("versions_days", DEFAULT_VERSIONS_DAYS)
    if not isinstance(versions_days, int) or versions_days < 1:
        raise ConfigError(f"folders.\"{relative_path}\": versions_days must be a whole number of days, at least 1")
    return Folder(relative_path, folder_id(relative_path), category, tuple(entry.get("ignore", [])), versions_days)


def _device(name: str, entry: dict, folders: dict[str, Folder]) -> Device:
    if not DEVICE_NAME.fullmatch(name):
        raise ConfigError(f"device name '{name}' must match {DEVICE_NAME.pattern}")
    if not entry.get("id"):
        raise ConfigError(f"devices.{name}: id is missing")
    role = entry.get("role", "device")
    if role not in ROLES:
        raise ConfigError(f"devices.{name}: role must be one of {', '.join(ROLES)}")
    paths = entry.get("paths", {})
    for relative_path in paths:
        if relative_path not in folders:
            raise ConfigError(f"devices.{name}.paths.\"{relative_path}\": no such folder")
    joined = entry.get("joined", True)
    if not isinstance(joined, bool):
        raise ConfigError(f"devices.{name}: joined must be true or false")
    return Device(name, entry["id"], role, entry.get("root", "/data"), entry.get("address", "dynamic"),
                  dict(paths), tuple(entry.get("not_synced", [])), joined)
