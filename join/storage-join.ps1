#Requires -Version 5.1
<#
.SYNOPSIS
Joins this Windows device to the storage network (specs/2026-10-20-connect-devices-design.md, the join
script): installs Tailscale if missing and joins the tailnet, writes the node file for the data root
and runs its Syncthing with its home on the node, registers with the storage dashboard and applies
the answer to that Syncthing. A second run changes nothing.

.DESCRIPTION
The node's Syncthing is the host agent's when storage-compose runs on this device (the agent finds
the node file and starts it); otherwise this script runs it at logon through a scheduled task of the
current user. Home folder links are left out on Windows, as tools/drive-sync does.

Settings (parameters, or the same environment variables as the Linux script): STORAGE_JOIN_KEY,
IMPRINT_PERSONAL, STORAGE_DASHBOARD, STORAGE_JOIN_ROOT (default F:\), STORAGE_JOIN_NAME,
STORAGE_JOIN_THRESHOLD, STORAGE_JOIN_OFFLINE_DIR (a folder with a Tailscale MSI), and, for a Syncthing
this script runs itself, STORAGE_JOIN_GUI_PORT and STORAGE_JOIN_LISTEN_PORT (default 8384 and 22000).
#>
param(
    [string]$Root = $(if ($env:STORAGE_JOIN_ROOT) { $env:STORAGE_JOIN_ROOT } else { "F:\" }),
    [string]$Name = $env:STORAGE_JOIN_NAME,
    [int]$Threshold = $(if ($env:STORAGE_JOIN_THRESHOLD) { [int]$env:STORAGE_JOIN_THRESHOLD } else { 0 }),
    [string]$Dashboard = $env:STORAGE_DASHBOARD,
    [string]$AuthKey = $env:STORAGE_JOIN_KEY
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repository = Split-Path $PSScriptRoot
. (Join-Path $repository "windows\agent-files.ps1")
. (Join-Path $repository "windows\passthrough.ps1")
. (Join-Path $repository "windows\nodes.ps1")
. (Join-Path $repository "windows\syncthing.ps1")
. (Join-Path $repository "windows\agent-install.ps1")

$userSyncthingGuiPort = $(if ($env:STORAGE_JOIN_GUI_PORT) { [int]$env:STORAGE_JOIN_GUI_PORT } else { 8384 })
$userSyncthingListenPort = $(if ($env:STORAGE_JOIN_LISTEN_PORT) { [int]$env:STORAGE_JOIN_LISTEN_PORT } else { 22000 })
$userSyncthingTaskPrefix = "storage-compose syncthing"
$joinChanges = 0

function Write-JoinLog([string]$Message) { Write-Host "storage-join: $Message" }

function Write-JoinChange([string]$Message) { $script:joinChanges++; Write-JoinLog $Message }

function Get-DeviceName {
    $raw = if ($Name) { $Name } else { $env:COMPUTERNAME }
    $clean = ($raw.ToLower() -replace '[^a-z0-9-]', '-').Trim('-')
    if (-not $clean) { throw "no usable device name; pass -Name" }
    return $clean
}

function Get-TailnetStatus {
    if (-not (Test-Path $tailscaleCli)) { return $null }
    $result = Invoke-NativeCommand $tailscaleCli @("status", "--json")
    try { return $result.Output | ConvertFrom-Json } catch { return $null }
}

function Get-TailnetState {
    $status = Get-TailnetStatus
    if ($status -and $status.PSObject.Properties["BackendState"]) { return $status.BackendState }
    return "NoState"
}

function Install-Tailscale {
    if (Test-Path $tailscaleCli) { return }
    $offline = Get-ChildItem -Path "$env:STORAGE_JOIN_OFFLINE_DIR" -Filter "tailscale-setup-*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($env:STORAGE_JOIN_OFFLINE_DIR -and $offline) { $result = Invoke-NativeCommand "msiexec.exe" @("/i", $offline.FullName, "/qn", "/norestart") }
    else { $result = Invoke-NativeCommand "winget" @("install", "--id", "Tailscale.Tailscale", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements") }
    if ($result.ExitCode -ne 0 -or -not (Test-Path $tailscaleCli)) { throw "Tailscale could not be installed: $($result.Output)" }
    Write-JoinChange "installed Tailscale"
}

function Get-AuthKey {
    if ($AuthKey) { return $AuthKey }
    $keyFile = if ($env:IMPRINT_PERSONAL) { Join-Path $env:IMPRINT_PERSONAL "tailscale.key" } else { $null }
    if ($keyFile -and (Test-Path $keyFile)) { return (Get-Content -Raw $keyFile).Trim() }
    throw "not on the tailnet yet and no auth key: pass -AuthKey (or STORAGE_JOIN_KEY) or put personal\tailscale.key on the stick"
}

function Join-Tailnet {
    if ((Get-TailnetState) -eq "Running") { return }
    $result = Invoke-NativeCommand $tailscaleCli @("up", "--auth-key=$(Get-AuthKey)", "--hostname=$(Get-DeviceName)", "--unattended")
    if ((Get-TailnetState) -ne "Running") { throw "tailscale up did not join the tailnet: $($result.Output)" }
    Write-JoinChange "joined the tailnet as $(Get-DeviceName)"
}

function Get-VolumeRoot([string]$Path) { return [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Path)) }

function Test-IsVolumeRoot([string]$Path) { return [System.IO.Path]::GetFullPath($Path).TrimEnd('\') -eq (Get-VolumeRoot $Path).TrimEnd('\') }

function New-NodeId {
    $bytes = New-Object byte[] 2
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Get-NodeKind { if (Test-IsVolumeRoot $Root) { return "drive" } return "folder" }

function Write-TextFile([string]$Path, [string]$Text) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
    [System.IO.File]::WriteAllText("$Path.partial", $Text)
    Move-Item -Force -LiteralPath "$Path.partial" -Destination $Path
}

function Write-NodeFile {
    $path = Get-NodeFilePath $Root
    if (Test-Path -LiteralPath $path) { return }
    if (-not (Test-Path -LiteralPath $Root)) { throw "the data root $Root does not exist" }
    Write-TextFile $path ("[node]`nid        = `"$(New-NodeId)`"`nname      = `"$(Get-DeviceName)`"`nkind      = `"$(Get-NodeKind)`"`nthreshold = $Threshold`nassigned  = []`n")
    Write-JoinChange "wrote $path"
}

<#
.NOTES
A folder node is found only through its volume's index, never by searching, so it is listed there.
#>
function Register-FolderNode {
    if ((Get-NodeKind) -ne "folder") { return }
    $volume = Get-VolumeRoot $Root
    $relative = [System.IO.Path]::GetFullPath($Root).Substring($volume.Length).TrimEnd('\').Replace('\', '/')
    $index = Get-NodeIndexPath $volume
    $paths = @()
    if (Test-Path -LiteralPath $index) { $paths = @((Read-TomlFile $index)[""]["paths"]) }
    if ($paths -contains $relative) { return }
    $paths += $relative
    Write-TextFile $index ("paths = [" + (($paths | ForEach-Object { "`"$_`"" }) -join ", ") + "]`n")
    Write-JoinChange "listed $relative in $index"
}

function Read-JoinNode { return Read-NodeFile ([System.IO.Path]::GetFullPath($Root)) }

function Get-AgentInstance($Node) {
    $heartbeat = Get-AgentHeartbeat $repository
    if (-not ($heartbeat -and (Test-AgentHeartbeatIsFresh $repository))) { return $null }
    $published = @($heartbeat.nodes | Where-Object { $_.id -eq $Node.id -and $_.syncthing.state -eq "running" }) | Select-Object -First 1
    if (-not $published) { return $null }
    return [pscustomobject]@{ ports = [pscustomobject]@{ gui = $published.syncthing.guiPort }; apiKey = $published.syncthing.apiKey; owner = "agent" }
}

function Get-UserTaskName($Node) { return "$userSyncthingTaskPrefix $($Node.name)" }

function Get-UserSyncthingArguments($Node) {
    $syncthingHome = Get-SyncthingHome $Node
    return "serve --home=`"$syncthingHome`" --no-browser --no-restart --no-upgrade --log-file=`"$([System.IO.Path]::Combine($syncthingHome, 'syncthing.log'))`" --log-max-size=$syncthingLogMaxBytes --log-max-old-files=2"
}

function Test-UserTaskIsCurrent($Node) {
    $task = Get-ScheduledTask -TaskName (Get-UserTaskName $Node) -ErrorAction SilentlyContinue
    if (-not $task) { return $false }
    $action = @($task.Actions)[0]
    return $action.Execute -eq $script:syncthingPath -and $action.Arguments -eq (Get-UserSyncthingArguments $Node)
}

function Register-UserSyncthingTask($Node) {
    if (Test-UserTaskIsCurrent $Node) { return }
    $action = New-ScheduledTaskAction -Execute $script:syncthingPath -Argument (Get-UserSyncthingArguments $Node)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName (Get-UserTaskName $Node) -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-JoinChange "registered the logon task '$(Get-UserTaskName $Node)'"
}

<#
.NOTES
Without the host agent the device's Syncthing is the user's, on the ports a single Syncthing on a
device uses; it listens on the tailnet only, like every node.
#>
function Start-UserSyncthing($Node) {
    $ports = [pscustomobject]@{ gui = $userSyncthingGuiPort; listen = $userSyncthingListenPort }
    New-Item -ItemType Directory -Force -Path (Get-SyncthingHome $Node) | Out-Null
    if (-not (Test-Path -LiteralPath (Get-SyncthingConfigPath $Node))) { New-SyncthingConfig $Node; Write-JoinChange "generated Syncthing's keys in $(Get-SyncthingHome $Node)" }
    $listenHost = Get-TailnetAddress
    if (-not $listenHost) { $listenHost = "127.0.0.1" }
    $running = Find-SyncthingProcess $Node
    $before = [System.IO.File]::ReadAllText((Get-SyncthingConfigPath $Node))
    if ($running) {
        $identity = Get-RunningSyncthingIdentity $Node
    } else {
        $identity = Set-SyncthingConfig $Node $ports $listenHost
        if ([System.IO.File]::ReadAllText((Get-SyncthingConfigPath $Node)) -ne $before) { Write-JoinChange "set Syncthing to the tailnet only" }
    }
    Set-UserSyncthingFirewallRules $Node $ports
    Register-UserSyncthingTask $Node
    if (-not $running) {
        Start-ScheduledTask -TaskName (Get-UserTaskName $Node)
        Write-JoinChange "started Syncthing for $($Node.root)"
    }
    return [pscustomobject]@{ ports = $ports; apiKey = $identity.apiKey; owner = "user" }
}

<#
.NOTES
The same rules the host agent makes, set before Syncthing first listens, so Windows never asks to
allow it and never adds a rule open to every address. They need an admin shell; without one the
script says so rather than leaving the device to that prompt silently.
#>
function Set-UserSyncthingFirewallRules($Node, $Ports) {
    if (-not (Test-IsElevated)) {
        Write-JoinLog "not an admin shell: no firewall rules set, so Windows will ask to allow Syncthing; answer for private networks only, or run this script again as admin"
        return
    }
    Set-SyncthingFirewallRule $Node $Ports
}

function Get-RunningSyncthingIdentity($Node) {
    $document = [xml][System.IO.File]::ReadAllText((Get-SyncthingConfigPath $Node))
    return [pscustomobject]@{ apiKey = $document.configuration.gui.apikey }
}

function Get-NodeSyncthing($Node) {
    $agent = Get-AgentInstance $Node
    if ($agent) { Write-JoinLog "the host agent runs this node's Syncthing"; return $agent }
    return Start-UserSyncthing $Node
}

function Invoke-JoinApi($Instance, [string]$Method, [string]$Path, $Body) {
    $arguments = @{ Method = $Method; Uri = "http://127.0.0.1:$($Instance.ports.gui)$Path"; Headers = @{ "X-API-Key" = $Instance.apiKey }; TimeoutSec = 10; UseBasicParsing = $true }
    if ($null -ne $Body) { $arguments["Body"] = (ConvertTo-Json -InputObject $Body -Depth 20 -Compress); $arguments["ContentType"] = "application/json" }
    return Invoke-RestMethod @arguments
}

function Get-JoinApiOrNull($Instance, [string]$Path) {
    try { return Invoke-JoinApi $Instance "Get" $Path $null }
    catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null }; throw }
}

function Wait-ForSyncthing($Instance) {
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        try { $status = Invoke-JoinApi $Instance "Get" "/rest/system/status" $null; if ($status.PSObject.Properties["myID"]) { return $status.myID } } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "Syncthing did not answer on 127.0.0.1:$($Instance.ports.gui) within 60 s"
}

function Get-DashboardUrl {
    if ($Dashboard) { return $Dashboard.TrimEnd('/') }
    $status = Get-TailnetStatus
    if (-not ($status -and $status.PSObject.Properties["MagicDNSSuffix"] -and $status.MagicDNSSuffix)) { throw "cannot tell the tailnet's name; pass -Dashboard" }
    return "https://storage.$($status.MagicDNSSuffix)"
}

function New-JoinRequest($Node, [string]$DeviceId) {
    return [ordered]@{
        name = Get-DeviceName; os = "windows"; syncthingDeviceId = $DeviceId
        nodes = @([ordered]@{ kind = $Node.kind; path = $Node.root; threshold = $Node.threshold })
    }
}

function Get-HttpErrorStatus($ErrorRecord) {
    if ($ErrorRecord.Exception.PSObject.Properties["Response"] -and $ErrorRecord.Exception.Response) { return [int]$ErrorRecord.Exception.Response.StatusCode }
    return 0
}

function Invoke-Dashboard($Node, [string]$DeviceId) {
    $body = ConvertTo-Json -InputObject (New-JoinRequest $Node $DeviceId) -Depth 10 -Compress
    try { return Invoke-RestMethod -Method Post -Uri "$(Get-DashboardUrl)/api/join" -Body $body -ContentType "application/json" -TimeoutSec 30 -UseBasicParsing }
    catch {
        switch (Get-HttpErrorStatus $_) {
            403 { throw "the dashboard refused this device (403): it is not on the tailnet's owner's account and not tagged tag:storage" }
            409 { throw "the dashboard knows $(Get-DeviceName) with another Syncthing ID (409): re-admit the reinstalled device from the dashboard" }
            default { throw "the dashboard at $(Get-DashboardUrl) did not accept the join: $_" }
        }
    }
}

function ConvertTo-Comparable($Value) { return ConvertTo-Json -InputObject $Value -Depth 10 -Compress }

function Set-JoinDevice($Instance, $Device) {
    $id = $Device.syncthingDeviceId
    $addresses = @($Device.addresses | Where-Object { $_ })
    if (-not $addresses) { $addresses = @("dynamic") }
    $current = Get-JoinApiOrNull $Instance "/rest/config/devices/$id"
    if ($current -and $current.name -eq $Device.name -and (ConvertTo-Comparable @($current.addresses)) -eq (ConvertTo-Comparable $addresses)) { return }
    $wanted = if ($current) { $current } else { [pscustomobject]@{ deviceID = $id } }
    $wanted | Add-Member -Force -NotePropertyName name -NotePropertyValue $Device.name
    $wanted | Add-Member -Force -NotePropertyName addresses -NotePropertyValue $addresses
    Invoke-JoinApi $Instance "Put" "/rest/config/devices/$id" $wanted | Out-Null
    Write-JoinChange "device $($Device.name) ($id) set"
}

function Get-JoinFolderPath($Node, [string]$Path) {
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return [System.IO.Path]::Combine($Node.root, $Path.Replace('/', '\'))
}

function Set-JoinFolder($Instance, $Node, $Folder, [string[]]$DeviceIds) {
    $path = Get-JoinFolderPath $Node $Folder.path
    $current = Get-JoinApiOrNull $Instance "/rest/config/folders/$($Folder.id)"
    if ($current -and $current.path.TrimEnd('\') -ne $path.TrimEnd('\')) { Write-JoinLog "folder $($Folder.id) NOT CHANGED: Syncthing has it at $($current.path), the dashboard says $path"; return }
    $base = if ($current) { $current } else { Invoke-JoinApi $Instance "Get" "/rest/config/defaults/folder" $null }
    $shared = @(@($base.devices | ForEach-Object { $_.deviceID }) + $DeviceIds | Where-Object { $_ } | Sort-Object -Unique)
    if ($current -and (ConvertTo-Comparable @($current.devices | ForEach-Object { $_.deviceID } | Sort-Object)) -eq (ConvertTo-Comparable $shared)) { return }
    if (-not $current) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
        $type = if ($Folder.PSObject.Properties["type"] -and $Folder.type) { $Folder.type } else { "sendreceive" }
        foreach ($pair in @(@("id", $Folder.id), @("label", $Folder.id), @("path", $path), @("type", $type))) { $base | Add-Member -Force -NotePropertyName $pair[0] -NotePropertyValue $pair[1] }
    }
    $base | Add-Member -Force -NotePropertyName devices -NotePropertyValue @($shared | ForEach-Object { [pscustomobject]@{ deviceID = $_ } })
    Invoke-JoinApi $Instance "Put" "/rest/config/folders/$($Folder.id)" $base | Out-Null
    Write-JoinChange "folder $($Folder.id) at $path shared with $(@($DeviceIds).Count) device(s)"
}

function Set-JoinAnswer($Instance, $Node, $Answer) {
    foreach ($device in @($Answer.devices | Where-Object { $_ })) { Set-JoinDevice $Instance $device }
    $deviceIds = @($Answer.devices | Where-Object { $_ } | ForEach-Object { $_.syncthingDeviceId })
    foreach ($folder in @($Answer.folders | Where-Object { $_ })) { Set-JoinFolder $Instance $Node $folder $deviceIds }
}

function Get-DefaultSyncthingHome { return [System.IO.Path]::Combine($env:LOCALAPPDATA, "Syncthing") }

function Get-HomeFromArguments([string]$Arguments) {
    if ($Arguments -match '(?:--home|-H)[= ]"([^"]+)"') { return $Matches[1] }
    if ($Arguments -match '(?:--home|-H)[= ](\S+)') { return $Matches[1] }
    return Get-DefaultSyncthingHome
}

function Test-IsSamePath([string]$First, [string]$Second) {
    return [System.IO.Path]::GetFullPath($First).TrimEnd('\') -eq [System.IO.Path]::GetFullPath($Second).TrimEnd('\')
}

<#
.NOTES
Only tasks that start a syncthing.exe other than the stack's own are another install's; the one this
script registers for the node runs the stack's binary.
#>
function Get-ExistingSyncthingTasks {
    foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
        foreach ($action in @($task.Actions | Where-Object { $_ -and $_.PSObject.Properties["Execute"] -and $_.Execute })) {
            $executable = [Environment]::ExpandEnvironmentVariables($action.Execute.Trim('"'))
            if ((Split-Path -Leaf $executable) -ne "syncthing.exe" -or (Test-IsSamePath $executable $script:syncthingPath)) { continue }
            [pscustomobject]@{ task = $task; executable = $executable; home = (Get-HomeFromArguments "$($action.Arguments)") }
        }
    }
}

function Find-ExistingSyncthing([string]$NodeHome) {
    if (Test-Path -LiteralPath ([System.IO.Path]::Combine($NodeHome, "config.xml"))) { return $null }
    $tasks = @(Get-ExistingSyncthingTasks)
    foreach ($candidate in @($tasks | ForEach-Object { $_.home }) + @(Get-DefaultSyncthingHome) | Select-Object -Unique) {
        if (Test-IsSamePath $candidate $NodeHome) { continue }
        if (-not (Test-Path -LiteralPath ([System.IO.Path]::Combine($candidate, "config.xml")))) { continue }
        $owned = @($tasks | Where-Object { Test-IsSamePath $_.home $candidate })
        return [pscustomobject]@{ home = $candidate; tasks = $owned; executables = @($owned | ForEach-Object { $_.executable } | Select-Object -Unique) }
    }
    return $null
}

function Get-ExistingSyncthingProcesses($Existing) {
    $executables = @($Existing.executables)
    return @(Get-CimInstance Win32_Process -Filter "Name='syncthing.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $process = $_
        ($process.ExecutablePath -and @($executables | Where-Object { Test-IsSamePath $_ $process.ExecutablePath }).Count -gt 0) -or
        ($process.CommandLine -and $process.CommandLine.Contains($Existing.home))
    })
}

<#
.NOTES
Shut down through its own API first, which only reaches the instance that owns this home; the
processes are ended only when they are the task's executable or name this home, so another Syncthing
on the device is never touched.
#>
function Stop-ExistingSyncthing($Existing) {
    foreach ($owned in $Existing.tasks) { Disable-ScheduledTask -TaskName $owned.task.TaskName -TaskPath $owned.task.TaskPath -ErrorAction SilentlyContinue | Out-Null }
    try {
        $gui = ([xml][System.IO.File]::ReadAllText([System.IO.Path]::Combine($Existing.home, "config.xml"))).configuration.gui
        $scheme = if ($gui.tls -eq "true") { "https" } else { "http" }
        Invoke-RestMethod -Method Post -Uri "$scheme`://$($gui.address)/rest/system/shutdown" -Headers @{ "X-API-Key" = $gui.apikey } -TimeoutSec 5 -UseBasicParsing | Out-Null
    } catch { }
    $deadline = (Get-Date).AddSeconds(30)
    while (@(Get-ExistingSyncthingProcesses $Existing).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    foreach ($process in Get-ExistingSyncthingProcesses $Existing) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $process.ProcessId -Timeout 15 -ErrorAction SilentlyContinue
    }
}

<#
.NOTES
Copied and checked file by file before the old home is deleted, so a failed copy never costs the
device its certificate and key, which are its device ID.
#>
function Move-SyncthingHome([string]$From, [string]$To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    Copy-Item -Path (Join-Path $From "*") -Destination $To -Recurse -Force
    foreach ($file in Get-ChildItem -LiteralPath $From -Recurse -File -Force) {
        $copy = [System.IO.Path]::Combine($To, $file.FullName.Substring($From.TrimEnd('\').Length + 1))
        if (-not (Test-Path -LiteralPath $copy) -or (Get-FileSha256 $copy) -ne (Get-FileSha256 $file.FullName)) { throw "copying $($file.FullName) to $copy failed; the old home is kept" }
    }
    Remove-Item -Recurse -Force -LiteralPath $From
}

<#
.NOTES
A device that already runs Syncthing (the drive-sync rollout's own install) keeps its device ID,
folders and devices: its home moves onto the node before the node file exists, so neither this
script nor the host agent ever generates new keys for it. The listen address and GUI are rewritten
when the node's Syncthing starts. The package that installed it stays; removing software is the
owner's call.
#>
function Move-ExistingSyncthing {
    $nodeHome = [System.IO.Path]::Combine([System.IO.Path]::GetFullPath($Root), ".storage\syncthing")
    $existing = Find-ExistingSyncthing $nodeHome
    if (-not $existing) { return }
    Stop-ExistingSyncthing $existing
    Move-SyncthingHome $existing.home $nodeHome
    foreach ($owned in $existing.tasks) { Unregister-ScheduledTask -TaskName $owned.task.TaskName -TaskPath $owned.task.TaskPath -Confirm:$false }
    Write-JoinChange "moved the existing Syncthing's home from $($existing.home) to $nodeHome, keeping its device ID, folders and devices"
    foreach ($owned in $existing.tasks) { Write-JoinChange "removed its logon task '$($owned.task.TaskName)'" }
    foreach ($executable in $existing.executables) { Write-JoinLog "left installed: $executable (remove the package, for example with winget, if nothing else uses it)" }
}

function Invoke-Join {
    Install-Tailscale
    Join-Tailnet
    $script:syncthingPath = Get-SyncthingBinary $repository
    Move-ExistingSyncthing
    Write-NodeFile
    Register-FolderNode
    $node = Read-JoinNode
    $instance = Get-NodeSyncthing $node
    $deviceId = Wait-ForSyncthing $instance
    $answer = Invoke-Dashboard $node $deviceId
    Set-JoinAnswer $instance $node $answer
    if ($script:joinChanges -eq 0) { Write-JoinLog "already joined; nothing changed" } else { Write-JoinLog "joined ($script:joinChanges changes)" }
}

if ($MyInvocation.InvocationName -ne ".") {
    try { Invoke-Join } catch { Write-Host "storage-join: $_" -ForegroundColor Red; exit 1 }
}
