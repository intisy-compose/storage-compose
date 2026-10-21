import os
import shutil
from pathlib import Path

from .config import Layout
from .plan import folder_path

HOME_LINKS = {
    "Documents": "Documents",
    "Pictures": "Pictures",
    "Music": "Music",
    "Videos": "Videos",
    "Downloads": "Downloads",
    "Desktop": "Desktop",
    "Templates": "Templates",
    "Public": "Public",
    "Documents/GitHub": "code",
}


class HomeConflict(Exception):
    pass


def _move_contents(source: Path, target: Path) -> int:
    entries = list(source.iterdir())
    clashes = sorted(entry.name for entry in entries if os.path.lexists(target / entry.name))
    if clashes:
        raise HomeConflict(f"{source} and {target} both hold: {', '.join(clashes)}")
    target.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        shutil.move(str(entry), str(target / entry.name))
    source.rmdir()
    return len(entries)


def link_home(target: Path, link: Path) -> str:
    if link.is_symlink():
        if link.exists() and link.resolve() == target.resolve():
            return "ok"
        raise HomeConflict(f"{link} points to {os.readlink(link)}, not {target}")
    if link.exists() and not link.is_dir():
        raise HomeConflict(f"{link} is a file")
    moved = _move_contents(link, target) if link.is_dir() else 0
    target.mkdir(parents=True, exist_ok=True)
    link.symlink_to(target, target_is_directory=True)
    return f"linked, {moved} entries moved" if moved else "linked"


def link_homes(layout: Layout, device_name: str, home: Path, log) -> None:
    device = layout.devices[device_name]
    for folder in layout.folders.values():
        name = HOME_LINKS.get(folder.relative_path)
        if name is None:
            continue
        try:
            log(f"~/{name}: {link_home(Path(folder_path(device, folder)), home / name)}")
        except HomeConflict as conflict:
            log(f"~/{name}: NOT LINKED, {conflict}")
