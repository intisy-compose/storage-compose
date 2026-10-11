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
    $lines = foreach ($line in Get-Content $configFile) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=' -and $Values.ContainsKey($Matches[1])) { "$($Matches[1])=$($Values[$Matches[1]])" }
        else { $line }
    }
    [System.IO.File]::WriteAllText($configFile, (($lines -join "`n") + "`n"))
}

function Initialize-Config {
    if (-not (Test-Path $configFile)) { Copy-Item $exampleFile $configFile }
    if (Get-ConfigValue "STORAGE_NODE" "") { Write-OK "config.env already names this host; nothing changed."; return }
    Set-ConfigValues @{ STORAGE_NODE = $env:COMPUTERNAME.ToLower() }
    Write-OK "Wrote STORAGE_NODE=$($env:COMPUTERNAME.ToLower()) to config.env."
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
    Connect-Enclosures
    Wait-ForMounter
    Connect-Tailnet
    Write-Step "Starting the stack..."
    docker compose @composeArgs up -d
    if ($LASTEXITCODE -eq 0) { Show-Urls }
}

function Stop-Array {
    Write-Step "Stopping everything and unmounting..."
    docker compose @composeArgs down
    Disconnect-Enclosures
}

function Show-Drives {
    docker run --rm --privileged $probe lsblk -o NAME,SIZE,FSTYPE,LABEL,MODEL,SERIAL,TRAN
}

function Show-Urls {
    Write-Host ""
    Write-Host "  Storage : https://$(Get-ConfigValue 'STORAGE_HOST' '')   (from any device on your tailnet)"
}

$commands = @{
    "init-config" = "Create config.env and name this host"
    "up"          = "Attach the enclosures, mount and lock the array, join the tailnet, start the stack (default)"
    "down"        = "Stop the stack, release the lock, unmount and give the enclosures back to Windows"
    "restart"     = "down, then up"
    "status"      = "Show the containers and their health"
    "logs"        = "[service]  follow logs, e.g. logs mounter"
    "drives"      = "List the block devices Docker Desktop's VM sees, with their labels"
    "url"         = "Print the tailnet URL"
    "sync"        = "[--anyway]  run a SnapRAID sync now; --anyway accepts more deletions than SYNC_MAX_DELETED"
    "scrub"       = "Run a SnapRAID scrub now (8 percent, blocks older than 10 days)"
    "snapraid"    = "[args]  run snapraid with the array's config, e.g. snapraid status"
}

switch ($Command.ToLower()) {
    "init-config" { Initialize-Config; break }
    "up"      { Start-Array; break }
    "down"    { Stop-Array; break }
    "restart" { Stop-Array; Start-Array; break }
    "status"  { docker compose @composeArgs ps -a; break }
    "logs"    { docker compose @composeArgs logs -f @forwarded; break }
    "drives"  { Show-Drives; break }
    "url"     { Show-Urls; break }
    "sync"    { docker compose @composeArgs exec -T snapraid snapraid.sh run sync @forwarded; exit $LASTEXITCODE }
    "scrub"   { docker compose @composeArgs exec -T snapraid snapraid.sh run scrub; exit $LASTEXITCODE }
    "snapraid" {
        docker compose @composeArgs exec -T snapraid snapraid.sh config | Out-Null
        docker compose @composeArgs exec -T snapraid snapraid -c /etc/snapraid.conf @forwarded; exit $LASTEXITCODE
    }
    default   { Show-Usage $commands; exit 1 }
}
