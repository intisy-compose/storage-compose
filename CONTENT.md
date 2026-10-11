A portable storage array in Docker: USB drive enclosures, mounted by label and pooled with
[mergerfs](https://github.com/trapexit/mergerfs), served over [Tailscale](https://tailscale.com/)
with real HTTPS to every device on your tailnet. It runs on whichever computer the enclosures are
plugged into, Linux directly and Windows through Docker Desktop and
[usbipd-win](https://github.com/dorssel/usbipd-win), and all of its state lives on the drives.

Status: mounting, the lock, the pool, the gateway and SnapRAID parity. The dashboard's actions,
Syncthing, Kopia and Samba follow.

## Stack

| service | image | role |
| --- | --- | --- |
| `mounter` | built, `debian:trixie-slim` | mounts every drive by its ext4 label under `/mnt/storage/<label>`, holds the array's lock, mirrors the stack state from `data1` to `data2` |
| `pool` | built, `debian:trixie-slim` + mergerfs 2.40 | one view of every data drive at `/mnt/storage/pool` |
| `snapraid` | built, `debian:trixie-slim` + SnapRAID 12.4 | writes SnapRAID's config from the drives it has seen, syncs once the last sync is a day old and scrubs once the last scrub is a week old |
| `tailscale` | `tailscale/tailscale:v1.102.4` | joins your tailnet as `storage` and forwards `:443`; its node key lives on the array |
| `gateway` | `caddy:2.11.4-alpine` | HTTPS for the `ts.net` name with certificates from Tailscale; a status page of the drives |

Every image is pinned to a version.

## Drives

Every drive is ext4 with a label naming its role: `storage-data1`, `storage-data2`, ...,
`storage-parity1`. The USB port, the device order and the host never matter. `storage-data1`
holds the stack state in `/.storage/`, mirrored to `storage-data2`.

**One host at a time**: the mounter writes its host name and a heartbeat into the lock on
`storage-data1` every minute and refuses to start while another host was seen in the last ten
minutes. `down` releases it.

## Parity

Every `*-parity*` drive holds SnapRAID parity for the `*-data*` drives, and every drive carries a
copy of the content file. The schedule is by age, not by clock time, because the array is only
plugged in now and then: whenever it is up, a sync runs once the last one is `SYNC_INTERVAL_HOURS`
old and a scrub (8 percent, blocks older than 10 days) once the last is `SCRUB_INTERVAL_DAYS` old.

A sync is refused, and the status page says why, when:

- more than `SYNC_MAX_DELETED` files were deleted since the last sync, so a mass deletion is not
  written into parity; `sync --anyway` accepts them;
- SnapRAID finds every file of a data drive missing or rewritten, which is what an unmounted or
  wiped drive looks like. `--anyway` does not override this, because forcing it would drop that
  drive's parity; `snapraid --force-empty sync` accepts it once you are sure.

A drive that ever was part of the array stays in SnapRAID's config while it is missing, so its
absence stops the sync instead of quietly removing it. The log of every run is
`/.storage/log/snapraid.log` on `storage-data1`.

## Quick start

Requires [Docker](https://docs.docker.com/get-docker/) and a Tailscale account with
[HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) enabled. On Windows also
usbipd-win (`winget install --id dorssel.usbipd-win -e`) and PowerShell.

```powershell
git clone https://github.com/intisy-compose/storage-compose
cd storage-compose

.\docker-compose.ps1 init-config   # creates config.env and names this host
# put the enclosures' VID:PID from `usbipd list` into USB_HARDWARE_IDS, and an auth key from
# https://login.tailscale.com/admin/settings/keys into TS_AUTHKEY
.\docker-compose.ps1 up            # the one CLI; run it without a known command to list them all
```

On Linux, `./docker-compose.sh` takes the same commands. The first `up` on Windows needs an admin
shell, to bind the enclosures to usbipd once; afterwards `down` only detaches them, so Windows keeps
using them while the array is down.

## Windows notes

- Docker Desktop's kernel ships `usb-storage` and `uas` as modules but never loads them; `up` loads
  them in the VM.
- usbipd's virtual host controller has no USB streams, so UAS enclosures run as plain usb-storage:
  slower, but they work.
- A device that carries a mounted Windows volume refuses to attach. Array drives are ext4, which
  Windows does not mount, so this only matters for a drive that still has an NTFS or exFAT volume.
