#Requires -Version 5.1
param([string]$Command = "up")

# $args, not ValueFromRemainingArguments, so -Switch tokens still bind when forwarded.
$forwarded = $args

Set-StrictMode -Version Latest

$configFile  = Join-Path $PSScriptRoot "config.env"
$exampleFile = Join-Path $PSScriptRoot "config.env.example"
$composeArgs = @("--env-file", $configFile)
$probe = "debian:trixie-slim"
$usbipdFolder = "C:\Program Files\usbipd-win"
$smartctlPackage = "winget install --id smartmontools.smartmontools --version 7.5 -e"

. (Join-Path $PSScriptRoot "windows\disks.ps1")
. (Join-Path $PSScriptRoot "windows\agent-files.ps1")
. (Join-Path $PSScriptRoot "windows\agent-install.ps1")
$composeProject = "storage-compose"
$attachRequestFile = Join-Path $PSScriptRoot $attachRequestFileName
$attachStateFile = Join-Path $PSScriptRoot $attachStateFileName

function Write-Step([string]$msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-OK([string]$msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host $msg -ForegroundColor Red }

function Show-Usage([hashtable]$Commands) {
    $width = ($Commands.Keys | Measure-Object -Property Length -Maximum).Maximum
    Write-Host "Usage: .\docker-compose.ps1 [$(($Commands.Keys | Sort-Object) -join '|')]"
    foreach ($cmd in $Commands.Keys | Sort-Object) {
        Write-Host ("  {0}  {1}" -f $cmd.PadRight($width), $Commands[$cmd])
    }
}

function Read-Config {
    $values = @{}
    if (-not (Test-Path $configFile)) { return $values }
    foreach ($line in Get-Content $configFile) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2].Trim('"') }
    }
    return $values
}

function Get-ConfigValue([string]$Name, [string]$Default) {
    $config = Read-Config
    if ($config.ContainsKey($Name) -and $config[$Name]) { return $config[$Name] }
    return $Default
}

function Assert-Config {
    if (-not (Test-Path $configFile)) {
        Write-Err "No config.env - run '.\docker-compose.ps1 init-config' first."; exit 1
    }
    if (-not (Get-ConfigValue "STORAGE_NODE" "")) { Write-Err "config.env is missing STORAGE_NODE - run init-config."; exit 1 }
}

function Set-ConfigValues([hashtable]$Values) {
    $written = @{}
    $lines = @(foreach ($line in Get-Content $configFile) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=' -and $Values.ContainsKey($Matches[1])) { $written[$Matches[1]] = $true; "$($Matches[1])=$($Values[$Matches[1]])" }
        else { $line }
    })
    foreach ($name in $Values.Keys) { if (-not $written.ContainsKey($name)) { $lines += "$name=$($Values[$name])" } }
    [System.IO.File]::WriteAllText($configFile, (($lines -join "`n") + "`n"))
}

function New-NtfyTopic {
    $bytes = New-Object byte[] 16
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return "storage-" + (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Initialize-Config {
    if (-not (Test-Path $configFile)) { Copy-Item $exampleFile $configFile }
    if (Get-ConfigValue "STORAGE_NODE" "") { Write-OK "config.env already names this host." }
    else {
        Set-ConfigValues @{ STORAGE_NODE = $env:COMPUTERNAME.ToLower() }
        Write-OK "Wrote STORAGE_NODE=$($env:COMPUTERNAME.ToLower()) to config.env."
    }
    if (Get-ConfigValue "NTFY_TOPIC" "") { Write-OK "config.env already has a notification topic." }
    else {
        Set-ConfigValues @{ NTFY_TOPIC = New-NtfyTopic }
        Write-OK "Wrote NTFY_TOPIC to config.env; subscribe to it in the ntfy app: $(Get-ConfigValue 'NTFY_URL' 'https://ntfy.sh')/$(Get-ConfigValue 'NTFY_TOPIC' '')"
    }
}

<#
.NOTES
usbipd writes its info lines to stderr; Windows PowerShell 5.1 turns those into errors once they are
redirected, so its output is passed through as text and judged by the exit code.
#>
function Invoke-Usbipd([string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & usbipd @Arguments 2>&1 | ForEach-Object { "$_" }
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

function Assert-Usbipd {
    if (Get-Command usbipd -ErrorAction SilentlyContinue) { return }
    if (Test-Path "$usbipdFolder\usbipd.exe") { $env:Path += ";$usbipdFolder"; return }
    Write-Err "usbipd-win is not installed: winget install --id dorssel.usbipd-win --version 5.3.0 -e"
    exit 1
}

function Get-EnclosureDevices {
    $hardwareIds = @((Get-ConfigValue "USB_HARDWARE_IDS" "") -split "," | ForEach-Object { $_.Trim().ToUpper() } | Where-Object { $_ })
    if (-not $hardwareIds) { return @() }
    $devices = (Invoke-Usbipd @("state")).Output -join "`n" | ConvertFrom-Json
    return @($devices.Devices | Where-Object {
        $_.BusId -and $_.InstanceId -match '^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})' -and "$($Matches[1]):$($Matches[2])" -in $hardwareIds
    })
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
.NOTES
A plain bind leaves the device with Windows until it is attached, so `down` only detaches and the
next `up` needs no admin shell. Docker Desktop's kernel ships usb-storage and uas as modules and never
loads them, so an attached drive stays unclaimed until they are loaded.
#>
function Connect-Enclosures {
    Assert-Usbipd
    $devices = Get-EnclosureDevices
    if (-not $devices) { Write-Err "No USB device matches USB_HARDWARE_IDS in config.env; see 'usbipd list'."; exit 1 }
    Write-Step "Attaching $($devices.Count) enclosure device(s) to Docker Desktop's VM..."
    docker run --rm --privileged --pid=host $probe nsenter -t 1 -m -- modprobe -a usb-storage uas
    foreach ($device in $devices) {
        if (-not $device.PersistedGuid) {
            if (-not (Test-IsAdministrator)) { Write-Err "Bus $($device.BusId) is not bound yet; run this once in an admin shell."; exit 1 }
            $bind = Invoke-Usbipd @("bind", "--busid", $device.BusId)
            if ($bind.ExitCode -ne 0) { Write-Err ($bind.Output -join "`n"); exit 1 }
        }
        if ($device.ClientIPAddress) { Write-OK "$($device.BusId) already attached"; continue }
        $attach = Invoke-Usbipd @("attach", "--wsl", "--busid", $device.BusId)
        if ($attach.ExitCode -ne 0) { Write-Err ($attach.Output | Where-Object { $_ -notmatch "info:" }) -join "`n"; exit 1 }
        Write-OK "$($device.BusId) $($device.Description) attached"
    }
}

function Disconnect-Enclosures {
    Assert-Usbipd
    foreach ($device in Get-EnclosureDevices) {
        if (-not $device.ClientIPAddress) { continue }
        Invoke-Usbipd @("detach", "--busid", $device.BusId) | Out-Null
        Write-OK "$($device.BusId) back with Windows"
    }
}

function Get-AttachMode {
    $mode = (Get-ConfigValue "ATTACH" "wsl").ToLower()
    if ($mode -notin @("wsl", "usbipd")) { Write-Err "ATTACH in config.env must be wsl or usbipd, not '$mode'."; exit 1 }
    return $mode
}

function Get-WatcherState { return Read-JsonFile $attachStateFile }

function Get-PassedDisks {
    $state = Get-WatcherState
    if (-not ($state -and $state.PSObject.Properties["disks"])) { return @() }
    return @($state.disks | Where-Object { $_ })
}

function Test-WatcherIsAlive($State) {
    if (-not ($State -and $State.heartbeat)) { return $false }
    return ((Get-Date) - [datetime]$State.heartbeat).TotalSeconds -lt 30
}

function Wait-ForWatcher([int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-WatcherIsAlive (Get-WatcherState)) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Assert-AttachWatcher {
    if (Wait-ForWatcher 30) { return }
    Write-Err "The host agent is not answering for this folder; see $attachLogFileName."
    exit 1
}

function Read-AttachRequestFile { return Read-JsonFile $attachRequestFile }

function Get-ReleasedDiskIds {
    $request = Read-AttachRequestFile
    if (-not ($request -and $request.active)) { return @() }
    return @($request.release | Where-Object { $_ })
}

function Show-RequestProblems($State) {
    foreach ($problem in @($State.requestProblems | Where-Object { $_ })) { Write-Err "  $problem" }
}

function Send-AttachRequest([bool]$Active, [object[]]$Attach = @(), [string[]]$Release = @()) {
    $id = [guid]::NewGuid().ToString()
    Write-JsonFile $attachRequestFile ([pscustomobject]@{ id = $id; active = $Active; attach = @($Attach); release = @($Release) })
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $state = Get-WatcherState
        if ($state -and $state.handledRequest -eq $id) { return $state }
        Start-Sleep -Seconds 1
    }
    Write-Err "The attach task did not take the request within 120 s (it waits while Docker Desktop is not running); see $attachLogFileName."
    exit 1
}

<#
.NOTES
The mounter's container is created first, so its status volume exists and the watcher can put the
host's SMART reports there before the mounter makes its first check.
#>
function Connect-WslDisks {
    Assert-AttachWatcher
    Write-Step "Passing the array drives through to WSL..."
    docker compose @composeArgs up --no-start mounter 2>$null | Out-Null
    $state = Send-AttachRequest -Active $true
    Show-RequestProblems $state
    $disks = @($state.disks | Where-Object { $_ })
    if (-not $disks) {
        Write-Err "No USB disk holds only Linux filesystem partitions, so nothing was passed through."
        Write-Err "'.\docker-compose.ps1 attach' lists the USB disks and what each is."
        exit 1
    }
    foreach ($disk in $disks) { Write-OK "disk $($disk.number) $($disk.model) passed through" }
}

function Get-DiskLabelReport {
    $report = @{}
    foreach ($line in @(docker compose @composeArgs exec -T mounter mounter.sh disk-labels 2>$null)) {
        $fields = "$line".Trim() -split "\s+"
        if ($fields.Count -eq 2) { $report[$fields[0].ToLower()] = $fields[1] }
    }
    return $report
}

<#
.NOTES
Only a disk the VM shows without an array label is handed back; one the VM does not show yet stays.
#>
function Disconnect-UnlabelledWslDisks {
    $report = Get-DiskLabelReport
    $unlabelled = @(Get-PassedDisks | Where-Object { $_ -and $_.source -eq "rule" -and $_.guid -and $report[$_.guid] -eq "unlabelled" })
    if (-not $unlabelled) { return }
    $state = Send-AttachRequest -Active $true -Release (@(Get-ReleasedDiskIds) + @($unlabelled | ForEach-Object { $_.guid }))
    Show-RequestProblems $state
    foreach ($disk in $unlabelled) { Write-OK "disk $($disk.number) $($disk.model) holds no array drive; given back to Windows" }
}

function Disconnect-WslDisks {
    if (-not (Test-WatcherIsAlive (Get-WatcherState))) { Write-Err "The attach task is not running, so the drives stay passed through to WSL."; return }
    $state = Send-AttachRequest -Active $false
    Show-RequestProblems $state
    Write-OK "Drives released from WSL; they stay offline in Windows"
}

function Show-UsbDisks {
    $passed = Get-PassedDisks
    $usbDisks = @(Get-Disk | Where-Object { $_.BusType -eq "USB" })
    if (-not $usbDisks) { Write-Host "No USB disks."; return }
    foreach ($disk in $usbDisks) {
        $partitions = Get-DiskPartitions $disk
        $verdict = "never passed through"
        if (Test-IsBlankDisk $disk $partitions) { $verdict = "blank: 'attach $($disk.Number)' passes it through as a replacement" }
        if (Test-IsArrayDisk $disk $partitions) { $verdict = "passed through by up" }
        if (@($passed | Where-Object { Test-IsSameDisk $disk $_ }).Count -gt 0) { $verdict = "passed through now" }
        Format-DiskDescription $disk $partitions | ForEach-Object { Write-Host "  $_" }
        Write-Host "    -> $verdict"
    }
}

function Add-WslDisk([string]$NumberText) {
    if ((Get-AttachMode) -ne "wsl") { Write-Err "attach needs ATTACH=wsl in config.env."; exit 1 }
    if (-not $NumberText) { Show-UsbDisks; return }
    $number = 0
    if (-not [int]::TryParse($NumberText, [ref]$number)) { Write-Err "attach takes a disk number, as listed by '.\docker-compose.ps1 attach'."; exit 1 }
    $disk = Get-Disk -Number $number -ErrorAction SilentlyContinue
    if (-not $disk) { Write-Err "There is no disk $number."; exit 1 }
    $partitions = Get-DiskPartitions $disk
    Format-DiskDescription $disk $partitions | ForEach-Object { Write-Host "  $_" }
    if (-not (Test-MayPassThroughOnRequest $disk $partitions)) {
        Write-Err "Refused: only a USB disk that is blank, or holds only Linux filesystem partitions, is passed through; never a system disk or a Windows volume."
        exit 1
    }
    $request = Read-AttachRequestFile
    if (-not ($request -and $request.active)) { Write-Err "The array is not up; run '.\docker-compose.ps1 up' first."; exit 1 }
    Assert-AttachWatcher
    Write-Host "Disk $number leaves Windows and the dashboard offers it as a replacement, which erases it once chosen."
    if ((Read-Host "Type the disk number to confirm") -ne "$number") { Write-Host "Nothing changed."; return }
    $state = Send-AttachRequest -Active $true -Attach @(Get-DiskIdentity $disk) -Release (Get-ReleasedDiskIds)
    Show-RequestProblems $state
    if (@(@($state.disks) | Where-Object { $_ -and (Test-IsSameDisk $disk $_) }).Count -eq 0) { exit 1 }
    Write-OK "disk $number passed through; pick it under Rebuild in the dashboard"
}

function Get-AgentPassThrough {
    if ((Get-AttachMode) -eq "wsl") { return "wsl" }
    return "none"
}

<#
.NOTES
The agent is a service (specs/2026-10-19-storage-nodes-and-dashboard-design.md, the host agent and its
lifetime): installed or repaired by every up, removed by down, and gone by itself 10 minutes after the
stack is.
#>
function Install-Agent {
    Write-Step "Checking the host agent..."
    try {
        if (Remove-LegacyAttachTask) { Write-OK "Removed the old WSL attach task; the host agent replaces it" }
        $result = Install-HostAgent $PSScriptRoot $composeProject (Get-AgentPassThrough)
    } catch { Write-Err "$_"; exit 1 }
    if ($result -eq "installed") { Write-OK "The host agent service is installed and running" } else { Write-OK "The host agent is running" }
    if ((Get-AgentPassThrough) -eq "wsl" -and -not (Get-Command smartctl.exe -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $env:ProgramFiles "smartmontools\bin\smartctl.exe"))) {
        Write-Err "smartctl is missing, so the dashboard shows no SMART for passed-through drives: $smartctlPackage"
    }
}

function Remove-Agent {
    try { if ((Uninstall-HostAgent $PSScriptRoot) -eq "removed") { Write-OK "The host agent is removed" } }
    catch { Write-Err "$_" }
}

function Connect-Drives {
    if ((Get-AttachMode) -eq "wsl") { Connect-WslDisks } else { Connect-Enclosures }
}

function Disconnect-Drives {
    if ((Get-AttachMode) -eq "wsl") { Disconnect-WslDisks } else { Disconnect-Enclosures }
}

function Wait-ForMounter {
    Write-Step "Mounting the array..."
    docker compose @composeArgs up -d mounter
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        $health = docker inspect -f "{{.State.Health.Status}}" storage-mounter 2>$null
        if ($health -eq "healthy") { Write-OK "Array mounted and locked"; return }
        $running = docker inspect -f "{{.State.Running}}" storage-mounter 2>$null
        if ($running -eq "false") { break }
        Start-Sleep -Seconds 2
    }
    Write-Err "The mounter did not get ready:"
    docker compose @composeArgs logs --tail 20 mounter
    docker compose @composeArgs stop mounter | Out-Null
    exit 1
}

function Get-TailnetStatus {
    $raw = docker compose @composeArgs exec -T tailscale tailscale --socket=/var/run/tailscale/tailscaled.sock status --json 2>$null
    if (-not $raw) { return $null }
    try { return ($raw | Out-String | ConvertFrom-Json) } catch { return $null }
}

function Test-HasJoined {
    $prefix = Get-ConfigValue "ARRAY_PREFIX" "storage"
    docker compose @composeArgs exec -T mounter test -f "/mnt/storage/$prefix-data1/.storage/tailscale/tailscaled.state"
    return $LASTEXITCODE -eq 0
}

function Connect-Tailnet {
    if (-not (Get-ConfigValue "TS_AUTHKEY" "") -and -not (Test-HasJoined)) {
        Write-Err "TS_AUTHKEY is empty in config.env and this array has not joined the tailnet yet."
        Write-Err "Create a key at https://login.tailscale.com/admin/settings/keys"
        exit 1
    }
    Write-Step "Joining the tailnet..."
    docker compose @composeArgs up -d tailscale
    $deadline = (Get-Date).AddSeconds(90)
    $tailnetHost = $null
    while ((Get-Date) -lt $deadline) {
        $status = Get-TailnetStatus
        if ($status -and $status.BackendState -eq "Running" -and $status.Self.DNSName) { $tailnetHost = $status.Self.DNSName.TrimEnd('.'); break }
        Start-Sleep -Seconds 2
    }
    if (-not $tailnetHost) {
        Write-Err "The node did not join within 90s. An expired or used-up TS_AUTHKEY is the usual cause;"
        Write-Err "check '.\docker-compose.ps1 logs tailscale'."
        exit 1
    }
    Write-OK "Joined as $tailnetHost"
    if ((Get-ConfigValue "STORAGE_HOST" "") -ne $tailnetHost) {
        Set-ConfigValues @{ STORAGE_HOST = $tailnetHost }
        Write-OK "Wrote STORAGE_HOST to config.env."
    }
}

<#
.NOTES
Every build stamps a new image ID, so building again after the array is up would recreate the
mounter under the running stack; the images are built once, before anything starts.
#>
function Start-Array {
    Assert-Config
    Write-Step "Building the images..."
    docker compose @composeArgs build --quiet
    if ($LASTEXITCODE -ne 0) { Write-Err "The build failed."; exit 1 }
    Install-Agent
    Connect-Drives
    Wait-ForMounter
    if ((Get-AttachMode) -eq "wsl") { Disconnect-UnlabelledWslDisks }
    Connect-Tailnet
    Write-Step "Starting the stack..."
    docker compose @composeArgs up -d
    if ($LASTEXITCODE -eq 0) { Show-Urls }
}

function Stop-Array {
    Write-Step "Stopping everything and unmounting..."
    docker compose @composeArgs down
    Disconnect-Drives
    Remove-Agent
}

function Show-Drives {
    docker run --rm --privileged $probe lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL,SERIAL,TRAN
}

function Show-Credentials {
    $secrets = "/mnt/storage/$(Get-ConfigValue 'ARRAY_PREFIX' 'storage')-data1/.storage/secrets"
    $read = { param($name) (docker compose @composeArgs exec -T mounter cat "$secrets/$name") -join "" }
    $hostName = Get-ConfigValue 'STORAGE_HOST' ''
    Write-Host "  Samba      : \\$hostName\storage   user storage, password $(& $read 'samba')"
    Write-Host "  Syncthing  : https://${hostName}:8384 or http://localhost:8443   user storage, password $(& $read 'syncthing-gui')"
    Write-Host "  Kopia      : https://${hostName}:51515   web UI user storage, password $(& $read 'kopia-server')"
    Write-Host "               clients need their own account: .\docker-compose.ps1 kopia-user <user@host>"
    Write-Host "  Kopia repository password (only for opening the repository without the server): $(& $read 'kopia-repository')"
}

function Show-Urls {
    Write-Host ""
    Write-Host "  Storage : https://$(Get-ConfigValue 'STORAGE_HOST' '')   (from any device on your tailnet)"
    Write-Host "  Locally : http://localhost:8442, Syncthing http://localhost:8443   (this host only)"
}

$commands = @{
    "init-config" = "Create config.env, name this host and generate the notification topic"
    "up"          = "Install or repair the host agent (admin shell), pass the drives through to WSL (or attach the enclosures with usbipd), mount and lock the array, join the tailnet, start the stack (default)"
    "down"        = "Stop the stack, release the lock, unmount and release the drives from WSL (or give the enclosures back), remove the host agent (admin shell)"
    "attach"      = "[disk number]  list the USB disks, or pass a blank one through to WSL as a replacement drive"
    "restart"     = "down, then up"
    "status"      = "Show the containers and their health"
    "logs"        = "[service]  follow logs, e.g. logs mounter"
    "drives"      = "List the block devices Docker Desktop's VM sees, with their labels"
    "url"         = "Print the tailnet URL"
    "sync"        = "[--anyway]  run a SnapRAID sync now; --anyway accepts more deletions than SYNC_MAX_DELETED"
    "scrub"       = "Run a SnapRAID scrub now (SCRUB_PERCENT of the array, blocks older than SCRUB_OLDER_THAN_DAYS)"
    "snapraid"    = "[args]  run snapraid with the array's config, e.g. snapraid status"
    "credentials" = "Print the Samba, Syncthing and Kopia logins, which live on the array"
    "kopia-user"  = "<user@host>  add a Kopia client account (or reset its password) and print it"
    "accept-smart" = "<role>  take a drive's current SMART counts as its baseline, e.g. accept-smart data2"
}

switch ($Command.ToLower()) {
    "init-config" { Initialize-Config; break }
    "up"      { Start-Array; break }
    "down"    { Stop-Array; break }
    "restart" { Stop-Array; Start-Array; break }
    "status"  { docker compose @composeArgs ps -a; break }
    "logs"    { docker compose @composeArgs logs -f @forwarded; break }
    "drives"  { Show-Drives; break }
    "attach"  { Add-WslDisk ($forwarded | Select-Object -First 1); break }
    "url"     { Show-Urls; break }
    "sync"    { docker compose @composeArgs exec -T snapraid snapraid.sh run sync @forwarded; exit $LASTEXITCODE }
    "scrub"   { docker compose @composeArgs exec -T snapraid snapraid.sh run scrub; exit $LASTEXITCODE }
    "credentials" { Show-Credentials; break }
    "kopia-user" { docker compose @composeArgs exec -T kopia kopia.sh user @forwarded; exit $LASTEXITCODE }
    "accept-smart" { docker compose @composeArgs exec -T mounter mounter.sh accept-smart @forwarded; exit $LASTEXITCODE }
    "snapraid" {
        docker compose @composeArgs exec -T snapraid snapraid.sh config | Out-Null
        docker compose @composeArgs exec -T snapraid snapraid -c /etc/snapraid.conf @forwarded; exit $LASTEXITCODE
    }
    default   { Show-Usage $commands; exit 1 }
}
