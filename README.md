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
| `mounter` | built, `debian:trixie-slim` | finds every node on the host by metadata: mounts each array's drives by their ext4 labels under `/mnt/storage/<label>`, holds each array's lock, mirrors the stack state from `data1` to `data2`, and lists the drive and folder nodes it finds under `NODE_VOLUMES` |
| `pool` | built, `debian:trixie-slim` + mergerfs 2.40 | one view of each array's data drives, the cluster's at `/mnt/storage/pool`, any other's at `/mnt/storage/pool-<id>` |
| `snapraid` | built, `debian:trixie-slim` + SnapRAID 12.4 | writes each array's SnapRAID config from the drives it has seen, syncs once the last sync is a day old and scrubs once the last scrub is a week old, each array on its own |
| `tailscale` | `tailscale/tailscale:v1.102.4` | joins your tailnet as `storage` inside the gateway's network and forwards the tailnet ports; its node key lives on the array |
| `dashboard` | built, TypeScript on Node 20 + SnapRAID | every node of this host and the other hosts, their drives with SMART health, parity, Syncthing devices and folders, the actions below, and the join of new devices |
| `gateway` | `caddy:2.11.4-alpine` | HTTPS for the `ts.net` name with certificates from Tailscale, in front of the dashboard and Kopia; the dashboard also on `127.0.0.1:8442`, the Syncthing GUI only there, on `127.0.0.1:8443` |
| `samba` | `ghcr.io/crazy-max/samba:4.23.8` | the pool as one SMB share, `\\storage.<tailnet>.ts.net\storage` |
| `syncthing` | `ghcr.io/syncthing/syncthing:2.1.6` | a Syncthing peer whose folders live anywhere in the pool, nested ones too (`pool/Documents`, `pool/Documents/GitHub`); its GUI is on this host only, `http://localhost:8443` |
| `nodes` | built, `debian:trixie-slim` + Syncthing 2.1.6 | one Syncthing per drive node, folder node and array other than the cluster, each with the identity kept on its own storage, on sync ports 22001 and up |
| `kopia` | built from the Kopia 0.23.1 release binary | a Kopia repository server on `pool/kopia`, `https://storage.<tailnet>.ts.net:51515` |

Every image is pinned to a version.

## Nodes

Every place that holds data is a node, with its identity in `.storage/node.toml` on its own
storage, so it stays the same node on whichever host it is attached to:

- **array**: several drives with SnapRAID parity. Each drive is ext4 with a label naming its array's
  4 hex digit id and its role: `a3f9-data1`, `a3f9-data2`, ..., `a3f9-parity1`. The USB port, the
  device order and the host never matter, and any number of arrays run side by side. Every member
  carries the whole array's description (its members' roles, labels, serials, sizes and asset
  notes), the copy with the highest `revision` winning, so any one drive names the members that
  are missing.
- **drive**: one volume whose root holds `.storage/node.toml`.
- **folder**: a folder on any volume, listed in `.storage/nodes.toml` at that volume's root
  (`paths = ["files"]`). Nothing below a volume's root is ever searched.

Nodes are found from metadata only: array drives by their labels, drive and folder nodes by those
two files at the roots of the volumes the host mounts under `NODE_VOLUMES` (Linux, opt-in: unset, the
stack looks only in its own `node-volumes-unset` folder; on Windows the host agent finds them). A device or mount event starts a discovery at once, and a slow poll
(`DISCOVERY_POLL_SECONDS`) catches a missed one.

The array named by `ARRAY_PREFIX`, the cluster, holds the stack state in `/.storage/` on its
`data1`, mirrored to `data2`. **One host at a time**: each array's mounter writes its host name and
a heartbeat into the lock on that array's `data1` every minute; the stack refuses to start while
another host held the cluster's lock in the last ten minutes, and leaves any other array alone
while its lock is held elsewhere. `down` releases them.

### Moving an array from the old labels

An array labelled `storage-data1`, ... moves to its id with the stack down:

```powershell
.\docker-compose.ps1 down
.\docker-compose.ps1 migrate-labels --dry-run   # shows each drive, its new label, serial and asset
.\docker-compose.ps1 migrate-labels --name private-array
.\docker-compose.ps1 up
```

On Windows each `migrate-labels` runs in an admin shell: it installs the host agent, has it pass the
drives through to WSL without mounting them, runs the migration in a one-off SnapRAID container
(which the agent counts as the stack running, so the drives stay for as long as SnapRAID's check
takes), then releases the drives and removes the agent again; `up` installs it for good.

It refuses unless every member listed in `snapraid.drives` is present and none is mounted, rewrites
only the ext4 labels and the member files (`snapraid.drives`, the folder record, the SMART
baselines), writes the node file with `array.toml`'s assets and serials on every member, keeps
`snapraid.drives.before-migration` and `array.toml.before-migration` beside the new files, and
checks with `snapraid status` and `snapraid diff` that SnapRAID, whose disks keep their names, sees
the same array. It can be run again after an interruption. `ARRAY_PREFIX` in `config.env` becomes
the id.

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
absence stops the sync instead of quietly removing it. Each array has its own config, job lock,
schedule and log, `/.storage/log/snapraid.log` on its `data1`. Every SnapRAID run goes through a
small wrapper that records it and its progress, so the dashboard shows a sync started by hand
(`docker-compose.ps1 snapraid sync`) as well as its own.

## When a drive drops off or fails

The mounter checks every drive every 10 seconds and puts each array in one of three states, which
the dashboard shows and every service follows; the dashboard calls a stopped array frozen:

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
offered as replacements, so the host's own disks never are. The same unused drives can be **added**
as the array's next data drive (typed `add` as confirmation), and a drive whose SMART counts rose
can have them **accepted** as its new baseline. Every action is scoped to one array
(`POST /api/arrays/<id>/<action>`). Anyone on your tailnet can use the dashboard; there is no second
login.

`GET /api/nodes` lists this host's nodes and, read over the tailnet from `STORAGE_PEERS`, the other
hosts'; a device only Syncthing knows shows Syncthing's view of it.

## Joining devices

A device on the tailnet joins with one call, which the join scripts in `join/` make on a device's
first boot, at `https://storage.<tailnet>.ts.net`:

`POST /api/join` with `{"name": "p53", "os": "linux", "syncthingDeviceId": "...", "nodes": [{"kind": "drive", "path": "/data", "threshold": 80}]}`

Tailscale forwards 443 to the gateway with the caller's tailnet address in a PROXY protocol header
(`TAILNET_PROXY_PROTOCOL: require`), and the gateway hands `/api/join` to the dashboard's internal
join port with the address in a header of its own, the one path on which the dashboard learns it;
`/api/join` on `localhost:8442` answers 421 naming the tailnet address. The dashboard asks tailscaled who the
caller is: a device tagged `tag:storage`, owned by the user
who owns this host's tailnet node, or owned by a login in `JOIN_ALLOWED_USERS` is admitted; anyone
else gets 403.
It adds the device to every Syncthing on this host, shares the folders the device's thresholds
admit (from the setup repo's folder list, priority 80 for `synced`, 30 for `archive`, 0 never
leaves its node), and records the device in the setup repo (`SETUP_REPO_DIR`, by default the stack's
own data repo in `data/`, with the list at `SETUP_LAYOUT`, by default `data/drive-sync.toml`) with a
commit and a push, or, while that repo holds no list, on this host only. Calling it again with the
same name and ID is harmless; a known name with another device ID gets 409.

## The data repo

`data/` is a submodule: the public
[storage-compose-data-template](https://github.com/intisy-compose/storage-compose-data-template),
so a fresh clone runs, holding an example `drive-sync.toml`. Swap in your own private repo with
`.\docker-compose.ps1 data use <owner/repo[@ref]>` (`./docker-compose.sh` on Linux; no source goes
back to the template) and check which one is in place with `data status`. Commit and push inside
`data/`; the submodule pointer in this repo stays on the template.

## drive-sync

`tools/drive-sync` applies the device list in `data/drive-sync.toml` to a device's own Syncthing:
it adds the other devices and every folder the list gives this device, links the home folders on
Linux and reports unlisted folders and sync conflicts. `systemd/drive-sync.service` runs it at
login. Its tests read `tests/fixtures/drive-sync.toml`, never a real list:
`python -m unittest discover -s tests -t .` from `tools/drive-sync`, and with
`DRIVE_SYNC_INTEGRATION=1` also the two-Syncthing test in Docker.

## Sharing, syncing and backups

Tailscale serve forwards the tailnet ports straight into the stack: 443 (dashboard and join API), 445 (Samba),
22000 (Syncthing sync), 22001 to 22008 (the node Syncthings) and 51515 (Kopia). The host itself
reaches the dashboard at `http://localhost:8442` and the Syncthing GUI at `http://localhost:8443`,
both published on 127.0.0.1; the GUI is not on the tailnet. The logins are generated once and kept on the cluster's `data1`, so every host that
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
.\docker-compose.ps1 up            # the one CLI; run it without a known command to list them all
```

On Windows the first `up` runs in an admin shell, because it installs the host agent (below); later
ones need it only when the agent must be repaired. On Linux, `./docker-compose.sh` takes the same
commands and nothing needs installing.

## Windows: the host agent

What has to run outside Docker on Windows runs in one Windows service, `storage-compose-agent`,
which `up` installs or repairs and `down` removes. It runs as SYSTEM, so it serves before anyone logs
in, and it acts only while the stack's containers run: a stack that crashed or was removed without
`down` gets its drives back within one round. Ten minutes after the stack is gone (its containers
stopped or removed, or its folder deleted) the agent releases everything and unregisters itself, so
a deleted stack leaves nothing behind. It does three things:

- passes the array's drives through to WSL (below), running `wsl.exe` as the user who ran `up`,
  since WSL refuses SYSTEM and keeps one VM per user;
- runs one Syncthing per drive or folder node on a Windows volume: a volume whose root holds
  `.storage\node.toml` is a drive node, and the folders listed in a root's `.storage\nodes.toml`
  are folder nodes; nothing below a root is ever searched. It looks when a volume arrives and once a
  minute. Each Syncthing keeps its home in the node's `.storage\syncthing`, so the node keeps its
  device ID on any host, listens on the tailnet only (ports 22001 and up) with its API on
  `127.0.0.1` (8450 and up), and is the pinned release that `up` downloads once into
  `host-agent\bin` and checks against its SHA-256;
- writes `host-agent\status\heartbeat.json` every 5 seconds for the dashboard, with each node's
  Syncthing, the drives passed through and when the agent would remove itself. Its log is
  `host-agent\agent.log`.

## Windows: how the drives reach Docker Desktop

`ATTACH` in `config.env` picks the way; `wsl` is the default.

- **`wsl`**: every USB disk whose partitions are all of the GPT type "Linux filesystem" (what the
  stack's format writes) is set offline in Windows and passed through to Docker Desktop's WSL2 VM
  with `wsl --mount --bare`, at the drive's own speed (161 MB/s read, 258 MB/s write measured,
  against about 25 MB/s for the whole array over usbipd). A disk with a Windows volume, a blank disk
  and the system disks are never touched. The host agent does it, since `wsl --mount` needs
  administrator rights every time; `up` and `down` hand it their request through
  `attach-request.json` beside `config.env`. It also passes a drive through again when it drops off
  USB and comes back, or when Docker Desktop or WSL restarts, and reads the drives' SMART counts
  every 10 minutes, because the VM's virtual disk cannot.
- **`attach`** lists the USB disks and what each one is; `attach <disk number>` passes a blank
  replacement drive through after showing it and asking for its number, so the dashboard offers it
  under Rebuild. A disk with anything but Linux filesystem partitions is refused.
- `down` releases the drives from WSL and leaves them offline in Windows.
- **`usbipd`** attaches the enclosures over [usbipd-win](https://github.com/dorssel/usbipd-win)
  instead (`winget install --id dorssel.usbipd-win --version 5.3.0 -e`, their VID:PID from
  `usbipd list` in `USB_HARDWARE_IDS`). The first `up` needs an admin shell to bind them once.
  It is much slower: usbipd's virtual host controller has no USB streams, so UAS enclosures run as
  plain usb-storage, and a device that carries a mounted Windows volume refuses to attach.

## Joining a device

A newly installed device joins the storage network with one script, run once (an imprint firstboot
hook does it on a fresh install) and harmless to run again:

- **Linux** (systemd; Arch, Debian or Fedora): `sudo join/storage-join.sh`
- **Windows**: `.\join\storage-join.ps1` from a checkout of this repository

It installs Tailscale and Syncthing if they are missing (on Arch from the stick's offline repository
first) and joins the tailnet with the auth key in `STORAGE_JOIN_KEY` or the stick's
`personal/tailscale.key`; writes the node file for the device's data root (`/data`, or `F:\` on
Windows; `STORAGE_JOIN_ROOT`) and starts Syncthing with its home on the node, listening on the
tailnet only; registers with the storage dashboard (`STORAGE_DASHBOARD`, default
`https://storage.<tailnet>`), adds the devices and folders it answers with, and on Linux links the
home folders (`~/Documents`, `~/code`, ...) into the node, moving what they held. On Windows the
node's Syncthing is the host agent's when this stack runs there, otherwise a logon task of the user
runs it. A new device node keeps the working and essential bands (threshold 50,
`STORAGE_JOIN_THRESHOLD`); 0, which keeps everything the network holds, is for the cluster, and the
scripts refuse it unless `STORAGE_JOIN_ALLOW_KEEP_ALL=1`.

Run from a terminal with no parameters and no `STORAGE_JOIN_*` variable set, either script asks the
three questions of imprint's review screen first: the node (a drive root, a folder, or none), the
threshold (0 to 100, with the bands named; 0 only after confirming that it keeps everything, backups
included; an existing node keeps its own) and whether to join now. Anything else (imprint's hook,
CI) runs without asking, from the settings. A folder node is also listed in its volume's
`.storage/nodes.toml`, which is how the host agent finds it, and a node inside another (a folder in
a listed folder node or on a drive node's volume, or a drive node over listed folders) is refused
before anything is written.

A Syncthing the device already runs (its home in `%LOCALAPPDATA%\Syncthing`, or the
one its logon task names) is adopted: it is stopped, its home moves into the node with its
certificate, folders and devices, so its device ID stays, and its logon task is removed; the package
that installed it stays installed. The script's header lists every setting.

## License

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
