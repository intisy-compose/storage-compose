A portable storage array in Docker: USB drive enclosures, mounted by label and pooled with
[mergerfs](https://github.com/trapexit/mergerfs), served over [Tailscale](https://tailscale.com/)
with real HTTPS to every device on your tailnet. It runs on whichever computer the enclosures are
plugged into, Linux directly and Windows through Docker Desktop and
[usbipd-win](https://github.com/dorssel/usbipd-win), and all of its state lives on the drives.

Status: the skeleton (mounting, the lock, the pool, the gateway). SnapRAID parity, the dashboard,
Syncthing, Kopia and Samba follow.

## Stack

| service | image | role |
| --- | --- | --- |
| `mounter` | built, `debian:trixie-slim` | mounts every drive by its ext4 label under `/mnt/storage/<label>`, holds the array's lock, mirrors the stack state from `data1` to `data2` |
| `pool` | built, `debian:trixie-slim` + mergerfs 2.40 | one view of every data drive at `/mnt/storage/pool` |
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
