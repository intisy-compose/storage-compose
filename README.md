# storage-compose

A portable storage array in Docker: USB drive enclosures pooled with mergerfs, protected by SnapRAID parity, and served over Tailscale with Samba, Syncthing and Kopia.

A portable storage array in Docker: USB drive enclosures, mounted by label and pooled with
[mergerfs](https://github.com/trapexit/mergerfs), served over [Tailscale](https://tailscale.com/)
with real HTTPS to every device on your tailnet, and at `http://localhost:8442` on the host. It runs
on whichever computer the enclosures are plugged into, Linux directly and Windows through Docker Desktop, whose
WSL2 VM gets the drives passed through with `wsl --mount --bare`, and all of its state lives on the drives.

Status: complete for test drives (mounting, the lock, the pool, SnapRAID parity, the dashboard,
Samba, Syncthing and Kopia); the migration onto the real drives follows.

## Stack

| service | image | role |
| --- | --- | --- |
| `mounter` | built, `debian:trixie-slim` | mounts every drive by its ext4 label under `/mnt/storage/<label>`, holds the array's lock, mirrors the stack state from `data1` to `data2` |
| `pool` | built, `debian:trixie-slim` + mergerfs 2.40 | one view of every data drive at `/mnt/storage/pool` |
| `snapraid` | built, `debian:trixie-slim` + SnapRAID 12.4 | writes SnapRAID's config from the drives it has seen, syncs once the last sync is a day old and scrubs once the last scrub is a week old |
| `tailscale` | `tailscale/tailscale:v1.102.4` | joins your tailnet as `storage` inside the gateway's network and forwards the tailnet ports; its node key lives on the array |
| `dashboard` | built, TypeScript on Node 20 + SnapRAID | the drives with SMART health, parity status, the log, and the actions below |
| `gateway` | `caddy:2.11.4-alpine` | HTTPS for the `ts.net` name with certificates from Tailscale, in front of the dashboard, the Syncthing GUI and Kopia; the dashboard and the Syncthing GUI also on `127.0.0.1:8442` and `:8443` |
| `samba` | `ghcr.io/crazy-max/samba:4.23.8` | the pool as one SMB share, `\\storage.<tailnet>.ts.net\storage` |
| `syncthing` | `ghcr.io/syncthing/syncthing:2.1.6` | a Syncthing peer whose folders live anywhere in the pool, nested ones too (`pool/Documents`, `pool/Documents/GitHub`); its GUI is `https://storage.<tailnet>.ts.net:8384` |
| `kopia` | built from the Kopia 0.23.1 release binary | a Kopia repository server on `pool/kopia`, `https://storage.<tailnet>.ts.net:51515` |

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

## When a drive drops off or fails

The mounter checks every drive every 10 seconds and puts the array in one of three states, which
the dashboard shows at the top and every service follows:

| state | when | the share | Syncthing | Kopia, sync, scrub |
| --- | --- | --- | --- | --- |
| **healthy** | every drive present, or one that dropped off is still being waited for | read-write | runs | run once every drive is present |
| **degraded** | no more drives missing or failing than there are parity drives, and `data1` present | read-write | folders on a missing or failing drive pause, the rest run | wait |
| **stopped** | more drives lost than parity can rebuild, or `data1` missing or read-only | read-only | every folder pauses | wait |

- **A drop is not a failure.** A drive that falls off the USB bus and is back within
  `DROP_GRACE_SECONDS` (2 minutes) is checked with `e2fsck -p`, mounted again and the array carries
  on; meanwhile the Syncthing folders on it pause and Kopia waits. Only a drive that stays away is
  missing.
- **Failing** means the filesystem went read-only after an error (every drive is mounted with
  `errors=remount-ro`), or SMART's reallocated, pending or uncorrectable counts rose above their
  values at the drive's first check (`accept-smart <role>` takes the current ones as the new
  baseline), or the drive needs more than `e2fsck -p` after a drop. A failing drive takes no more
  writes; its files stay readable.
- **Syncthing never sees a lost drive as deletions.** The pool keeps every folder on one drive
  (mergerfs `epmfs`), so a folder leaves with its drive, `.stfolder` marker included, and its folders
  pause before the drive's mount is let go. A folder that lies on more than one drive is reported.
- **Notifications** go to [ntfy](https://ntfy.sh): a drive dropped, back, missing or failing, a
  rising SMART count, a state change, a failed or refused sync or scrub, and a reminder every day
  while the array is not healthy. `init-config` generates the topic (`NTFY_TOPIC`); subscribe to it
  in the ntfy app. `NTFY_URL` points at a self-hosted ntfy instead.

## Dashboard

`https://storage.<tailnet>.ts.net` shows the array's state and every drive the array has known (label, model, serial,
used and free space, SMART health with temperature, reallocated and pending sectors or NVMe wear),
the last sync and scrub, why a sync was refused, and the log. It can start a sync or a scrub, and
for a missing drive it offers:

- **Rebuild onto a replacement**: an unused drive you pick is erased, labelled with the missing
  role, and SnapRAID restores the files onto it (or recomputes parity), then checks them.
- **Continue without it** (data drives except `data1`): the drive leaves the array and its files
  are lost; parity is recomputed without it.

Both erase or give up data, so each needs the role typed as confirmation. Only drives on
`CANDIDATE_TRANSPORTS` (USB by default) that are writable, unmounted and carry no array label are
offered as replacements, so the host's own disks never are. Anyone on your tailnet can use the
dashboard; there is no second login.

## Sharing, syncing and backups

Tailscale serve forwards the tailnet ports straight into the stack: 443 (dashboard), 445 (Samba),
8384 (Syncthing GUI), 22000 (Syncthing sync) and 51515 (Kopia). Outside the tailnet only the host
itself reaches the dashboard (`http://localhost:8442`) and the Syncthing GUI
(`http://localhost:8443`), both published on 127.0.0.1. The logins are generated once and kept on `storage-data1`, so every host that
runs the array presents the same ones; `credentials` prints them.

- **Samba**: user `storage`. The share hides the stack's own folders (`.storage`, `kopia`,
  `lost+found`), so the backup repository cannot be edited by hand.
- **Syncthing**: add the storage node as a device on your other machines; it is reachable at
  `tcp://storage.<tailnet>.ts.net:22000`, and Syncthing's relays work too.
- **Kopia**: each client gets its own account with `kopia-user <user@host>`, then connects with
  `kopia repository connect server --url=https://storage.<tailnet>.ts.net:51515
  --override-username=<user> --override-hostname=<host>`. Kopia serves gRPC only over TLS, so it
  has its own self-signed certificate behind Caddy, which carries the real one.

## Quick start

Requires [Docker](https://docs.docker.com/get-docker/) and a Tailscale account with
[HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) enabled. On Windows also Docker
Desktop on WSL2, PowerShell and smartmontools (`winget install --id smartmontools.smartmontools
--version 7.5 -e`), which reads the drives' SMART from the Windows side.

```powershell
git clone https://github.com/intisy-compose/storage-compose
cd storage-compose

.\docker-compose.ps1 init-config   # creates config.env, names this host, generates the ntfy topic
# put an auth key from https://login.tailscale.com/admin/settings/keys into TS_AUTHKEY
.\docker-compose.ps1 install-attach   # Windows, once, in an admin shell
.\docker-compose.ps1 up            # the one CLI; run it without a known command to list them all
```

On Linux, `./docker-compose.sh` takes the same commands and nothing needs installing.

## Windows: how the drives reach Docker Desktop

`ATTACH` in `config.env` picks the way; `wsl` is the default.

- **`wsl`**: every USB disk whose partitions are all of the GPT type "Linux filesystem" (what the
  stack's format writes) is set offline in Windows and passed through to Docker Desktop's WSL2 VM
  with `wsl --mount --bare`, at the drive's own speed (161 MB/s read, 258 MB/s write measured,
  against about 25 MB/s for the whole array over usbipd). A disk with a Windows volume, a blank disk
  and the system disks are never touched. `wsl --mount` needs administrator rights every time, so
  an elevated scheduled task does it: `install-attach`, run once in an admin shell, copies it to
  `C:\Program Files\storage-compose` and registers it to start at logon; `up` and `down` then run
  from a normal shell and hand it their request through `attach-request.json` beside `config.env`.
  The task also passes a drive through again when it drops off USB and comes back, or when Docker
  Desktop or WSL restarts, and reads the drives' SMART counts every 10 minutes, because the VM's
  virtual disk cannot. Run `install-attach` again after updating the stack; `up` says when it is due.
- **`attach`** lists the USB disks and what each one is; `attach <disk number>` passes a blank
  replacement drive through after showing it and asking for its number, so the dashboard offers it
  under Rebuild. A disk with anything but Linux filesystem partitions is refused.
- `down` releases the drives from WSL and leaves them offline in Windows.
- **`usbipd`** attaches the enclosures over [usbipd-win](https://github.com/dorssel/usbipd-win)
  instead (`winget install --id dorssel.usbipd-win --version 5.3.0 -e`, their VID:PID from
  `usbipd list` in `USB_HARDWARE_IDS`). The first `up` needs an admin shell to bind them once.
  It is much slower: usbipd's virtual host controller has no USB streams, so UAS enclosures run as
  plain usb-storage, and a device that carries a mounted Windows volume refuses to attach.

## License

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
