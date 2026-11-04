#Requires -Version 5.1
<#
.SYNOPSIS
Joins this Windows device to the storage network (specs/2026-10-20-connect-devices-design.md, the join
script): installs Tailscale if missing and joins the tailnet, writes the node file for the data root,
has the host agent run its Syncthing with its home on the node, registers with the storage dashboard
and applies the answer to that Syncthing. A second run changes nothing. -Leave deletes the node file
instead, and the agent stops the node's Syncthing.

.DESCRIPTION
The node's Syncthing is always the host agent's (specs/2026-11-03-host-agent-joined-mode-design.md).
Where storage-compose runs, its agent finds the node file and starts it. Elsewhere this script installs
the agent in joined mode from this checkout, which needs an admin shell; the script says so before it
changes anything. A device joined before joined mode, its Syncthing run by a logon task of the user,
is handed to the agent on a rerun: the task, that Syncthing and the rules the join set go. Home folder
links are left out on Windows, as tools/drive-sync does.

Settings (parameters, or the same environment variables as the Linux script): STORAGE_JOIN_KEY,
IMPRINT_PERSONAL, STORAGE_DASHBOARD, STORAGE_JOIN_ROOT (default F:\), STORAGE_JOIN_NAME (default the
name of the device list's entry with this device's Syncthing ID, from STORAGE_JOIN_LAYOUT, by default
data\drive-sync.toml, else the computer's name),
STORAGE_JOIN_THRESHOLD (default 50; 0 only with STORAGE_JOIN_ALLOW_KEEP_ALL=1) and
STORAGE_JOIN_OFFLINE_DIR (a folder with a Tailscale MSI).

Run from a console with no parameters and none of the STORAGE_JOIN_* variables set, it asks for the
node, the threshold and whether to join, as imprint's review screen does. A folder node is also listed
in its drive's .storage\nodes.toml; a node inside another is refused.
#>
param(
    [string]$Root = $(if ($env:STORAGE_JOIN_ROOT) { $env:STORAGE_JOIN_ROOT } else { "F:\" }),
    [string]$Name = $env:STORAGE_JOIN_NAME,
    [int]$Threshold = $(if ($env:STORAGE_JOIN_THRESHOLD) { [int]$env:STORAGE_JOIN_THRESHOLD } else { 50 }),
    [string]$Dashboard = $env:STORAGE_DASHBOARD,
    [string]$AuthKey = $env:STORAGE_JOIN_KEY,
    [switch]$Leave
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repository = Split-Path $PSScriptRoot
. (Join-Path $repository "windows\agent-files.ps1")
. (Join-Path $repository "windows\passthrough.ps1")
. (Join-Path $repository "windows\nodes.ps1")
. (Join-Path $repository "windows\syncthing.ps1")
. (Join-Path $repository "windows\agent-install.ps1")

$agentNodeWaitSeconds = 120
$essentialThreshold = 80
$workingThreshold = 50
$joinChanges = 0
$keepAllConfirmed = $false

function Write-JoinLog([string]$Message) { Write-Host "storage-join: $Message" }

function Write-JoinChange([string]$Message) { $script:joinChanges++; Write-JoinLog $Message }

function Get-LayoutPath {
    if ($env:STORAGE_JOIN_LAYOUT) { return $env:STORAGE_JOIN_LAYOUT }
    return Join-Path $repository "data\drive-sync.toml"
}

<#
.NOTES
A line scan rather than the TOML reader: only the [devices.*] headers and their id lines are needed,
and the folder tables hold multi-line arrays and quoted keys.
#>
function Get-LayoutDeviceName([string]$DeviceId) {
    $path = Get-LayoutPath
    if (-not ($DeviceId -and (Test-Path -LiteralPath $path))) { return $null }
    $section = $null
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match '^\s*\[devices\.("?)([A-Za-z0-9_-]+)\1\]\s*$') { $section = $Matches[2]; continue }
        if ($line -match '^\s*\[') { $section = $null; continue }
        if ($section -and $line -match '^\s*id\s*=\s*"([^"]*)"' -and $Matches[1] -eq $DeviceId) { return $section }
    }
    return $null
}

function ConvertTo-DeviceName([string]$Raw) { return ($Raw.ToLower() -replace '[^a-z0-9-]', '-').Trim('-') }

<#
.NOTES
The computer's name, never the user's: a device list entry names the machine.
#>
function Get-DeviceName([string]$DeviceId) {
    $raw = if ($Name) { $Name } else { Get-LayoutDeviceName $DeviceId }
    if (-not $raw) { $raw = [System.Net.Dns]::GetHostName() }
    $clean = ConvertTo-DeviceName $raw
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

function Get-RootSyncthing { return [pscustomobject]@{ root = [System.IO.Path]::GetFullPath($Root) } }

<#
.NOTES
A kept connections.json belonged to the old device ID, so new keys start from the tailnet only.
#>
function New-JoinSyncthingKeys($Node) {
    New-SyncthingConfig $Node
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath ([System.IO.Path]::Combine((Get-SyncthingHome $Node), "connections.json"))
}

<#
.NOTES
The keys exist before the node file, so the file is named after the device list's entry for this
device's ID; the host agent then finds a home that already has them.
#>
function Initialize-SyncthingKeys {
    if (Test-Path -LiteralPath (Get-NodeFilePath $Root)) { return }
    $rootSyncthing = Get-RootSyncthing
    if (Test-Path -LiteralPath (Get-SyncthingConfigPath $rootSyncthing)) { return }
    if (-not (Test-Path -LiteralPath $Root)) { throw "the data root $Root does not exist" }
    New-Item -ItemType Directory -Force -Path (Get-SyncthingHome $rootSyncthing) | Out-Null
    New-JoinSyncthingKeys $rootSyncthing
    Write-JoinChange "generated Syncthing's keys in $(Get-SyncthingHome $rootSyncthing)"
}

function Write-NodeFile {
    $path = Get-NodeFilePath $Root
    if (Test-Path -LiteralPath $path) { return }
    if (-not (Test-Path -LiteralPath $Root)) { throw "the data root $Root does not exist" }
    $nodeName = Get-DeviceName (Get-SyncthingDeviceId (Get-RootSyncthing))
    Write-TextFile $path ("[node]`nid        = `"$(New-NodeId)`"`nname      = `"$nodeName`"`nkind      = `"$(Get-NodeKind)`"`nthreshold = $Threshold`nassigned  = []`n")
    Write-JoinChange "wrote $path"
}

function Get-RelativeNodePath([string]$Path) {
    return [System.IO.Path]::GetFullPath($Path).Substring((Get-VolumeRoot $Path).Length).TrimEnd('\').Replace('\', '/')
}

function Get-IndexPaths([string]$VolumeRoot) {
    $index = Get-NodeIndexPath $VolumeRoot
    if (-not (Test-Path -LiteralPath $index)) { return @() }
    $table = (Read-TomlFile $index)[""]
    if (-not $table.ContainsKey("paths")) { return @() }
    return @($table["paths"] | Where-Object { $_ } | ForEach-Object { "$_" })
}

function Test-IsNestedPath([string]$First, [string]$Second) {
    $ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
    return $First.StartsWith("$Second/", $ignoreCase) -or $Second.StartsWith("$First/", $ignoreCase)
}

<#
.NOTES
The host agent's rule: a node is never nested in another, or its files would be synced twice.
#>
function Get-NodePlacementProblem([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { return $null }
    $volume = Get-VolumeRoot $full
    if (Test-IsVolumeRoot $full) {
        if (@(Get-IndexPaths $volume).Count -gt 0) { return "$(Get-NodeIndexPath $volume) lists folder nodes, and a node is never nested in another, so $volume cannot be a drive node" }
        return $null
    }
    if (Test-Path -LiteralPath (Get-NodeFilePath $volume)) { return "the drive $volume is a drive node, and a node is never nested in another" }
    $relative = Get-RelativeNodePath $full
    foreach ($listed in Get-IndexPaths $volume) {
        if ($listed -ne $relative -and (Test-IsNestedPath $relative $listed)) { return "$($full.TrimEnd('\')) and $volume$($listed.Replace('/', '\')) are nested; a folder node cannot hold another" }
    }
    return $null
}

function Assert-NodePlacement {
    $problem = Get-NodePlacementProblem $Root
    if ($problem) { throw $problem }
}

<#
.NOTES
A folder node is found only through its volume's index, never by searching, so it is listed there.
#>
function Register-FolderNode {
    if ((Get-NodeKind) -ne "folder") { return }
    $volume = Get-VolumeRoot $Root
    $relative = Get-RelativeNodePath $Root
    $index = Get-NodeIndexPath $volume
    $paths = @(Get-IndexPaths $volume)
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

<#
.NOTES
Asked before any change, so a device that cannot have the agent installed is not left half joined.
Where the stack's agent runs, it runs this node too and nothing is installed.
#>
function Assert-JoinCanInstallAgent {
    if ((Get-InstalledAgentMode) -eq "stack" -or (Test-IsElevated)) { return }
    throw "storage-compose does not run on this device, so the join installs the host agent to run the node's Syncthing and keep its firewall rules, which needs an admin shell; nothing was changed, run it again as admin"
}

function Test-HasNodeFirewallRules($Node) {
    return @(Get-AllNodeFirewallRuleNames $Node | Where-Object { Get-NetFirewallRule -Name $_ -ErrorAction SilentlyContinue }).Count -gt 0
}

<#
.NOTES
A device joined before joined mode ran the node's Syncthing from a logon task of the user, with rules
the join set itself; the agent would take that Syncthing over on the wrong ports. The task always
goes, the Syncthing and the rules only while no agent runs, since a joined-mode agent's Syncthing on
this home is its own. That Syncthing is shut down through its own API first, as an adopted one is.
#>
function Move-NodeSyncthingToAgent($Node) {
    foreach ($removed in @(Remove-NodeSyncthingTasks @(Get-SyncthingHome $Node))) { Write-JoinChange "removed the logon task '$removed'; the host agent runs the node's Syncthing" }
    if ((Get-InstalledAgentMode) -ne "none") { return }
    if (@(Get-NodeSyncthingProcesses $Node).Count -gt 0) {
        Stop-ExistingSyncthing ([pscustomobject]@{ home = (Get-SyncthingHome $Node); tasks = @(); executables = @() })
        Write-JoinChange "stopped the Syncthing the logon task started"
    }
    if (Test-HasNodeFirewallRules $Node) {
        Remove-NodeFirewallRules $Node
        Write-JoinChange "removed the firewall rules the join set; the host agent keeps them"
    }
}

<#
.NOTES
The agent finds a new node file on its next scan in stack mode, up to a minute later, and in its next
round in joined mode; until then its heartbeat does not list the node, which is no reason to start a
second Syncthing for the same home.
#>
function Wait-ForAgentInstance($Node) {
    $deadline = (Get-Date).AddSeconds($agentNodeWaitSeconds)
    while ($true) {
        $instance = Get-AgentInstance $Node
        if ($instance) { return $instance }
        if ((Get-Date) -ge $deadline) { throw "the host agent has not started $($Node.root) within $agentNodeWaitSeconds s; see $agentFolderName\$agentLogName" }
        Start-Sleep -Seconds 2
    }
}

function Get-NodeSyncthing($Node) {
    if ((Get-InstalledAgentMode) -eq "stack") {
        $agent = Wait-ForAgentInstance $Node
        Write-JoinLog "the host agent runs this node's Syncthing"
        foreach ($removed in @(Remove-AgentNodeSyncthingTasks $repository)) { Write-JoinChange "removed the logon task '$removed'; the host agent runs its node's Syncthing" }
        return $agent
    }
    Move-NodeSyncthingToAgent $Node
    if ((Install-JoinedAgent $repository $Node.root (Get-DashboardUrl)) -eq "installed") { Write-JoinChange "installed the host agent in joined mode for $($Node.root)" }
    return Wait-ForAgentInstance $Node
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
        name = Get-DeviceName $DeviceId; os = "windows"; syncthingDeviceId = $DeviceId
        nodes = @([ordered]@{ kind = $Node.kind; path = $Node.root; threshold = $Node.threshold })
    }
}

function Get-HttpErrorStatus($ErrorRecord) {
    if ($ErrorRecord.Exception.PSObject.Properties["Response"] -and $ErrorRecord.Exception.Response) { return [int]$ErrorRecord.Exception.Response.StatusCode }
    return 0
}

<#
.NOTES
Windows PowerShell leaves ErrorDetails empty for a chunked answer, which Caddy sends, so the body is
read from the response itself.
#>
function Get-DashboardErrorText($ErrorRecord) {
    $text = if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { $ErrorRecord.ErrorDetails.Message } else { "" }
    if (-not $text -and $ErrorRecord.Exception.PSObject.Properties["Response"] -and $ErrorRecord.Exception.Response) {
        try { $text = (New-Object System.IO.StreamReader($ErrorRecord.Exception.Response.GetResponseStream())).ReadToEnd() } catch { }
    }
    try { $parsed = $text | ConvertFrom-Json; if ($parsed.PSObject.Properties["error"]) { return $parsed.error } } catch { }
    return $text
}

function Invoke-Dashboard($Node, [string]$DeviceId) {
    $body = ConvertTo-Json -InputObject (New-JoinRequest $Node $DeviceId) -Depth 10 -Compress
    try { return Invoke-RestMethod -Method Post -Uri "$(Get-DashboardUrl)/api/join" -Body $body -ContentType "application/json" -TimeoutSec 30 -UseBasicParsing }
    catch {
        $failure = $_
        switch (Get-HttpErrorStatus $failure) {
            403 { throw "the dashboard refused this device (403): $(Get-DashboardErrorText $failure)" }
            409 { throw "the dashboard knows $(Get-DeviceName $DeviceId) with another Syncthing ID (409): re-admit the reinstalled device from the dashboard" }
            default { throw "the dashboard at $(Get-DashboardUrl) did not accept the join: $failure" }
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

<#
.NOTES
Threshold 0 keeps everything the network holds, backups and archives included, which only the
cluster is meant to; a device node keeps the working and essential bands (50).
#>
function Assert-JoinThreshold {
    $threshold = $Threshold
    $nodeFile = Get-NodeFilePath ([System.IO.Path]::GetFullPath($Root))
    if (Test-Path -LiteralPath $nodeFile) { $threshold = (Read-NodeFile ([System.IO.Path]::GetFullPath($Root))).threshold }
    if ($threshold -ne 0 -or $env:STORAGE_JOIN_ALLOW_KEEP_ALL -eq "1" -or $script:keepAllConfirmed) { return }
    throw "threshold 0 keeps everything the network holds, backups and archives included, which only the cluster should; use 50 (working and essential), or set STORAGE_JOIN_ALLOW_KEEP_ALL=1"
}

function Read-JoinAnswer([string]$Question, [string]$Default) {
    $prompt = if ($Default) { "$Question [$Default]" } else { $Question }
    $answer = Read-Host $prompt
    if ($null -eq $answer) { throw "no answer to: $Question" }
    if ($answer.Trim() -eq "") { return $Default }
    return $answer.Trim()
}

function Confirm-JoinChoice([string]$Question, [bool]$Default) {
    $hint = if ($Default) { "Y/n" } else { "y/N" }
    while ($true) {
        $answer = Read-JoinAnswer "$Question [$hint]" ""
        if (-not $answer) { return $Default }
        if ($answer -match '^(y|yes)$') { return $true }
        if ($answer -match '^(n|no)$') { return $false }
        Write-JoinLog "yes or no, please"
    }
}

function Get-ThresholdBands([int]$Value) {
    if ($Value -le 0) { return "keeps EVERYTHING, backups included" }
    if ($Value -ge $essentialThreshold) { return "keeps essential" }
    if ($Value -ge $workingThreshold) { return "keeps essential and working" }
    return "keeps essential, working and archive"
}

function Get-RootChoiceProblem([string]$Kind, [string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\') { return "a full path with its drive letter, like F:\ or F:\storage, please" }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return "$Path does not exist" }
    if ($Kind -eq "drive" -and -not (Test-IsVolumeRoot $Path)) { return "$Path is not a drive root (its drive is $(Get-VolumeRoot $Path)); choose it as a folder" }
    if ($Kind -eq "folder" -and (Test-IsVolumeRoot $Path)) { return "$Path is a drive root; a folder node is a folder below one" }
    return Get-NodePlacementProblem $Path
}

function ConvertTo-RootChoice([string]$Path) {
    if ($Path -match '^[A-Za-z]:\\?$') { return "$($Path.Substring(0, 2).ToUpper())\" }
    return $Path.TrimEnd('\')
}

function Select-JoinRoot([string]$Kind, [string]$Question, [string]$Default) {
    while ($true) {
        $path = ConvertTo-RootChoice (Read-JoinAnswer $Question $Default)
        $problem = Get-RootChoiceProblem $Kind $path
        if (-not $problem) { $script:Root = $path; return }
        Write-JoinLog $problem
    }
}

function Select-JoinNode {
    $isDrive = (Test-Path -LiteralPath $Root -PathType Container) -and (Test-IsVolumeRoot $Root)
    $default = if ($isDrive) { "1" } else { "3" }
    Write-JoinLog "the drive or folder this device keeps in the storage network:"
    Write-JoinLog "  1) a drive root"
    Write-JoinLog "  2) a folder"
    Write-JoinLog "  3) none: this device does not join the storage network"
    while ($true) {
        switch (Read-JoinAnswer "choose 1, 2 or 3" $default) {
            "1" { Select-JoinRoot "drive" "the drive root that becomes the storage node (like F:\)" $(if ($isDrive) { $Root } else { "" }); return $true }
            "2" { Select-JoinRoot "folder" "the folder that becomes the storage node (a full path)" ""; return $true }
            "3" { return $false }
            default { Write-JoinLog "1, 2 or 3, please" }
        }
    }
}

function Select-JoinThreshold {
    $full = [System.IO.Path]::GetFullPath($Root)
    if (Test-Path -LiteralPath (Get-NodeFilePath $full)) { Write-JoinLog "$(Get-NodeFilePath $full) keeps its threshold, $((Read-NodeFile $full).threshold)"; return }
    while ($true) {
        $answer = Read-JoinAnswer "threshold, 0 to 100 (essential 80+, working 50+, archive 1+, 0 keeps everything)" "$Threshold"
        if ($answer -notmatch '^\d{1,3}$' -or [int]$answer -gt 100) { Write-JoinLog "the threshold is a whole number from 0 to 100, not '$answer'"; continue }
        $value = [int]$answer
        if ($value -eq 0) {
            if (-not (Confirm-JoinChoice "threshold 0 keeps EVERYTHING the storage network holds, backups and archives included. Keep everything?" $false)) {
                Write-JoinLog "the threshold was not changed"
                continue
            }
            $script:keepAllConfirmed = $true
        }
        $script:Threshold = $value
        Write-JoinLog "threshold $value, $(Get-ThresholdBands $value)"
        return
    }
}

function Test-HasAuthKey {
    if ($AuthKey) { return $true }
    return [bool]($env:IMPRINT_PERSONAL -and (Test-Path -LiteralPath (Join-Path $env:IMPRINT_PERSONAL "tailscale.key")))
}

function Select-JoinNow {
    $default = $true
    if (-not (Test-HasAuthKey) -and (Get-TailnetState) -ne "Running") {
        $default = $false
        Write-JoinLog "no Tailscale key (-AuthKey or personal\tailscale.key) and not on the tailnet yet: a join now stops at the tailnet"
    }
    return Confirm-JoinChoice "join the storage network now?" $default
}

<#
.NOTES
Returns false when the answers mean there is nothing to do.
#>
function Read-JoinChoices {
    if (-not (Select-JoinNode)) { Write-JoinLog "no storage node chosen; this device does not join the storage network"; return $false }
    Select-JoinThreshold
    if (-not (Select-JoinNow)) { Write-JoinLog "not joining; run this again to join"; return $false }
    Write-JoinLog "joining with the $(Get-NodeKind) node at $Root"
    return $true
}

function Test-InputIsTerminal { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected }

function Test-IsInteractiveJoin([int]$BoundParameterCount) {
    if ($BoundParameterCount -gt 0 -or -not (Test-InputIsTerminal)) { return $false }
    return @(Get-ChildItem Env: | Where-Object { $_.Name -like "STORAGE_JOIN_*" }).Count -eq 0
}

function Invoke-Join {
    Assert-JoinCanInstallAgent
    Assert-JoinThreshold
    Assert-NodePlacement
    Install-Tailscale
    Join-Tailnet
    $script:syncthingPath = Get-SyncthingBinary $repository
    Move-ExistingSyncthing
    Initialize-SyncthingKeys
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
    try {
        if ((Test-IsInteractiveJoin $PSBoundParameters.Count) -and -not (Read-JoinChoices)) { exit 0 }
        Invoke-Join
    } catch { Write-Host "storage-join: $_" -ForegroundColor Red; exit 1 }
}
