import re
from dataclasses import dataclass

from .config import ConfigError, Device, Folder, Layout

WINDOWS_ROOT = re.compile(r"^[A-Za-z]:")


@dataclass(frozen=True)
class FolderPlan:
    id: str
    label: str
    path: str
    type: str
    ignore_delete: bool
    versions_days: int | None
    ignore: tuple[str, ...]
    devices: tuple[str, ...]


def _join(root: str, *parts: str) -> str:
    separator = "\\" if WINDOWS_ROOT.match(root) else "/"
    return root.rstrip("/\\") + separator + separator.join(parts)


def default_path(device: Device, folder: Folder) -> str:
    return _join(device.root, *folder.relative_path.split("/"))


def folder_path(device: Device, folder: Folder) -> str:
    return device.paths.get(folder.relative_path) or default_path(device, folder)


def _folder_type(device: Device, folder: Folder) -> str:
    if folder.category == "synced":
        return "sendreceive"
    return "receiveonly" if device.role == "archive" else "sendonly"


def plan_for(layout: Layout, device_name: str) -> list[FolderPlan]:
    device = layout.devices[device_name]
    shared_with = tuple(sorted(
        other.id for other in layout.devices.values() if other.joined or other.name == device_name
    ))
    plans = []
    for folder in layout.folders.values():
        if folder.category == "local":
            continue
        is_archive_copy = folder.category == "archive" and device.role == "archive"
        only_uploads = folder.category == "archive" and device.role == "device"
        plans.append(FolderPlan(
            id=folder.id,
            label=folder.relative_path,
            path=folder_path(device, folder),
            type=_folder_type(device, folder),
            ignore_delete=is_archive_copy,
            versions_days=None if only_uploads else folder.versions_days,
            ignore=folder.ignore,
            devices=shared_with,
        ))
    return plans


def _comparable(path: str) -> str:
    normalized = path.replace("\\", "/").rstrip("/")
    return normalized.lower() if WINDOWS_ROOT.match(normalized) else normalized


def _ignores(folder: Folder, relative: str) -> bool:
    return f"/{relative}" in (pattern.removeprefix("(?d)") for pattern in folder.ignore)


def check_nesting(layout: Layout, device_name: str) -> None:
    """@implNote A folder inside another one is synced twice, once through each folder, unless the
    outer folder ignores it; Documents holds Documents/GitHub on every device."""
    device = layout.devices[device_name]
    paths = {folder.relative_path: folder_path(device, folder) for folder in layout.folders.values()}
    for outer_name, outer_path in paths.items():
        outer = _comparable(outer_path) + "/"
        for inner_name, inner_path in paths.items():
            inner = _comparable(inner_path)
            if inner_name == outer_name or not inner.startswith(outer):
                continue
            relative = inner_path.replace("\\", "/").rstrip("/")[len(outer):]
            if not _ignores(layout.folders[outer_name], relative):
                raise ConfigError(f"{inner_name} at {inner_path} lies inside {outer_name} at {outer_path}; "
                                  f"add \"/{relative}\" to folders.\"{outer_name}\".ignore")
