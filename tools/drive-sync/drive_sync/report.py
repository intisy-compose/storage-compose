import os
import re
from pathlib import Path

from .config import Device, Layout
from .plan import default_path, folder_path

CONFLICT_MARKER = ".sync-conflict-"
NEVER_REPORTED = {"lost+found"}
PLAIN_NAME = re.compile(r"[\w.-]+")
ROOT_NAME = re.compile(r"/([^/*?\[{]+)")


def unlisted_folders(root: Path, listed) -> list[str]:
    return sorted(
        entry.name for entry in root.iterdir()
        if entry.is_dir() and entry.name not in listed
        and entry.name not in NEVER_REPORTED and not entry.name.startswith(".Trash")
    )


def listed_names(layout: Layout, device: Device) -> set[str]:
    return {folder.top_level for folder in layout.folders.values()} | set(device.not_synced)


def skipped_names(ignore: tuple[str, ...]) -> set[str]:
    names = (pattern.removeprefix("(?d)") for pattern in ignore)
    return {name for name in names if PLAIN_NAME.fullmatch(name)}


def skipped_at_root(ignore: tuple[str, ...]) -> set[str]:
    names = (ROOT_NAME.fullmatch(pattern.removeprefix("(?d)")) for pattern in ignore)
    return {name.group(1) for name in names if name}


def conflict_files(folder: Path, skipped, skipped_at_top=frozenset()) -> list[Path]:
    found = []
    for directory, subdirectories, files in os.walk(folder):
        at_top = Path(directory) == folder
        subdirectories[:] = sorted(
            d for d in subdirectories
            if d not in skipped and d != ".stversions" and not (at_top and d in skipped_at_top)
        )
        found += [Path(directory, name) for name in sorted(files) if CONFLICT_MARKER in name]
    return found


def bypassed_defaults(layout: Layout, device: Device) -> list[tuple[str, str]]:
    """A folder this device keeps elsewhere, whose place under the root still exists: what is in that
    place is listed but not synced, so it is named rather than left out silently."""
    bypassed = []
    for relative_path, path in device.paths.items():
        default = default_path(device, layout.folders[relative_path])
        if Path(default).is_dir() and Path(default).resolve() != Path(path).resolve():
            bypassed.append((default, path))
    return bypassed


def report(layout: Layout, device_name: str, log) -> None:
    device = layout.devices[device_name]
    root = Path(device.root)
    if root.is_dir():
        for name in unlisted_folders(root, listed_names(layout, device)):
            log(f"{root / name} has no category; add it to the list or move it")
    for default, path in bypassed_defaults(layout, device):
        log(f"{default} is not synced: this device syncs that folder from {path}; move its files there")
    for folder in layout.folders.values():
        path = Path(folder_path(device, folder))
        if folder.category != "synced" or not path.is_dir():
            continue
        for conflict in conflict_files(path, skipped_names(folder.ignore), skipped_at_root(folder.ignore)):
            log(f"conflict: {conflict}")
