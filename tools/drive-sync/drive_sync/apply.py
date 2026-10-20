import time
from typing import Callable

from .config import Layout
from .plan import FolderPlan, plan_for
from .syncthing import SyncthingError

SECONDS_PER_DAY = 86400
VERSION_CLEANUP_SECONDS = 3600
IGNORE_ATTEMPTS = 10


def _versioning(days: int | None) -> dict:
    if days is None:
        return {"type": "", "params": {}}
    return {
        "type": "staggered",
        "params": {"maxAge": str(days * SECONDS_PER_DAY), "cleanInterval": str(VERSION_CLEANUP_SECONDS)},
        "cleanupIntervalS": VERSION_CLEANUP_SECONDS,
    }


def folder_config(base: dict, plan: FolderPlan) -> dict:
    folder = dict(base)
    shared = list(base.get("devices", []))
    known = {device["deviceID"] for device in shared}
    folder.update(
        id=plan.id,
        label=plan.label,
        path=plan.path,
        type=plan.type,
        ignoreDelete=plan.ignore_delete,
        devices=shared + [{"deviceID": device_id} for device_id in plan.devices if device_id not in known],
        versioning=_versioning(plan.versions_days),
    )
    return folder


def _apply_devices(client, layout: Layout, device_name: str, log) -> None:
    for other in layout.devices.values():
        if other.name == device_name or not other.joined:
            continue
        known = client.device(other.id)
        device = dict(known or {})
        device.update(deviceID=other.id, name=other.name, addresses=[other.address])
        client.put_device(device)
        if known is None:
            log(f"added device {other.name}")


def _set_ignores(client, plan: FolderPlan, retry_delay_seconds: float) -> None:
    """@implNote A folder Syncthing has only just created rejects ignore patterns until it runs."""
    for attempt in range(IGNORE_ATTEMPTS):
        try:
            client.set_ignores(plan.id, plan.ignore)
            return
        except SyncthingError:
            if attempt == IGNORE_ATTEMPTS - 1:
                raise
            time.sleep(retry_delay_seconds)


def _add_folder(client, plan: FolderPlan, retry_delay_seconds: float) -> None:
    """@implNote Created paused, so its first scan cannot index what its ignore patterns exclude."""
    folder = folder_config(client.default_folder(), plan)
    client.put_folder({**folder, "paused": True})
    _set_ignores(client, plan, retry_delay_seconds)
    client.put_folder({**folder, "paused": False})


def apply_layout(client, layout: Layout, device_name: str, log: Callable[[str], None],
                 retry_delay_seconds: float = 1) -> None:
    _apply_devices(client, layout, device_name, log)
    for plan in plan_for(layout, device_name):
        existing = client.folder(plan.id)
        if existing is not None and existing.get("path") != plan.path:
            log(f"folder {plan.id} NOT CHANGED: Syncthing has it at {existing.get('path')}, "
                f"the list says {plan.path}; move it by hand")
            continue
        if existing is None:
            _add_folder(client, plan, retry_delay_seconds)
            log(f"added folder {plan.id} ({plan.type}) at {plan.path}")
        else:
            client.put_folder(folder_config(existing, plan))
            _set_ignores(client, plan, retry_delay_seconds)
