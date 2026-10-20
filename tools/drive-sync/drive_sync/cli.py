"""drive-sync apply: makes this device's Syncthing, home links and reports match the list.

Run it after changing the list, and at login (systemd/drive-sync.service). The list is the spec's
category list, docs/specs/2026-10-16-drive-sync-design.md.
"""
import argparse
import sys
import tomllib
from pathlib import Path

from .apply import apply_layout
from .config import ConfigError, Layout, load
from .home import link_homes
from .plan import check_nesting
from .report import report
from .syncthing import Client, SyncthingError, find_endpoint

SHOWN_ID_CHARACTERS = 7


def own_device(layout: Layout, my_id: str) -> str:
    for device in layout.devices.values():
        if device.id == my_id:
            return device.name
    raise ConfigError(f"this Syncthing ({my_id[:SHOWN_ID_CHARACTERS]}) is not in the list")


def _arguments(argv):
    parser = argparse.ArgumentParser(prog="drive-sync", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    apply = commands.add_parser("apply", help="apply the list to this device")
    apply.add_argument("--config", type=Path, required=True, help="the category list (TOML)")
    apply.add_argument("--syncthing-home", type=Path, help="folder holding Syncthing's config.xml")
    apply.add_argument("--api-url", help="Syncthing's GUI address, instead of reading config.xml")
    apply.add_argument("--api-key", help="Syncthing's API key, with --api-url")
    apply.add_argument("--no-home-links", action="store_true", help="leave the home directory alone")
    return parser.parse_args(argv)


def _run(arguments) -> None:
    try:
        layout = load(arguments.config)
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ConfigError(f"{arguments.config}: {error}") from error
    for device_name in layout.devices:
        check_nesting(layout, device_name)
    if arguments.api_url:
        url, api_key = arguments.api_url, arguments.api_key
    else:
        url, api_key = find_endpoint(arguments.syncthing_home)
    client = Client(url, api_key)
    device_name = own_device(layout, client.my_id())
    apply_layout(client, layout, device_name, print)
    if sys.platform != "win32" and not arguments.no_home_links:
        link_homes(layout, device_name, Path.home(), print)
    report(layout, device_name, print)


def main(argv: list[str] | None = None) -> int:
    arguments = _arguments(argv)
    try:
        _run(arguments)
    except (ConfigError, SyncthingError) as error:
        print(f"drive-sync: {error}", file=sys.stderr)
        return 1
    return 0
