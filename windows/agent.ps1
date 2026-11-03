#Requires -Version 5.1
<#
.SYNOPSIS
The storage-compose host agent on Windows (specs/2026-10-19-storage-nodes-and-dashboard-design.md, the
host agent and its lifetime, and specs/2026-11-03-host-agent-joined-mode-design.md). In stack mode it
passes the array's drives through to WSL, runs one native Syncthing per drive or folder node it finds,
and writes a heartbeat for the dashboard, all only while the stack's containers run, and removes
itself ten minutes after the stack is gone. In joined mode, on a device joined without the stack, it
runs the Syncthing of each node its joins named while that node's file exists, with the entry fetched
from the node's dashboard, and removes itself once none is left. Run as SYSTEM by the
storage-compose-agent service; started without -ConfigFile it only defines its functions (the tests
use that).
#>
param([string]$ConfigFile, [string]$StopSignal)

Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "agent-files.ps1")
. (Join-Path $PSScriptRoot "passthrough.ps1")
. (Join-Path $PSScriptRoot "nodes.ps1")
. (Join-Path $PSScriptRoot "syncthing.ps1")
. (Join-Path $PSScriptRoot "networks.ps1")
. (Join-Path $PSScriptRoot "dashboard-entry.ps1")

$agentRoundSeconds = 5
$nodeScanIntervalSeconds = 60
$joinedFetchIntervalSeconds = 60
$stackGraceSeconds = 600
$requestStartWindowSeconds = 600
$volumeEventName = "storage-compose-volume-change"
$runningContainerStates = @("running", "restarting")

$agentConfig = $null
$agentMode = "stack"
$agentState = $null
$agentStateChanged = $false
$connectionsFile = $null
$stackGoneSince = $null
$requestFirstSeen = @{}
$lastNodeScan = [datetime]::MinValue
$foundNodes = [pscustomobject]@{ nodes = @(); problems = @() }
$networksProblem = ""
$joinedNodeEntries = @()
$hasJoinedNodes = $true
$lastJoinedFetch = [datetime]::MinValue
$joinedDeviceIds = @{}
$joinedFetchProblems = @{}

function Get-Now { return Get-Date }

function Read-AgentConfig([string]$Path) {
    $config = Read-JsonFile $Path
    if (-not $config) { throw "cannot read $Path" }
    foreach ($name in @("stackFolder", "projectName", "userSid", "passThrough", "syncthingPath", "syncthingSha256")) {
        if (-not $config.PSObject.Properties[$name]) { throw "$Path has no $name" }
    }
    return $config
}

function Initialize-Agent($Config) {
    $script:agentConfig = $Config
    $script:agentMode = Get-AgentMode $Config
    $script:joinedNodeEntries = @(Get-ConfiguredJoinedNodes $Config)
    $script:projectName = $Config.projectName
    $script:userSid = $Config.userSid
    $script:syncthingPath = $Config.syncthingPath
    $script:syncthingSha256 = $Config.syncthingSha256
    if ($Config.PSObject.Properties["graceSeconds"] -and $Config.graceSeconds) { $script:stackGraceSeconds = [int]$Config.graceSeconds }
    $agentFolder = Get-AgentFolder $Config.stackFolder
    $script:requestFile = Join-Path $Config.stackFolder $attachRequestFileName
    $script:stateFile = Join-Path $Config.stackFolder $attachStateFileName
    $script:logFile = Join-Path $agentFolder $agentLogName
    $script:agentStateFile = Join-Path $agentFolder $agentStateName
    $script:connectionsFile = $(if ($script:agentMode -eq "joined") { Get-AgentJoinedConnectionsFile $Config.stackFolder } else { Get-AgentConnectionsFile $Config.stackFolder })
    $script:heartbeatFile = Join-Path (Get-AgentStatusFolder $Config.stackFolder) $agentHeartbeatName
    if (Test-Path -LiteralPath $Config.stackFolder) { New-Item -ItemType Directory -Force -Path (Get-AgentStatusFolder $Config.stackFolder) | Out-Null }
    $script:agentState = New-AgentState (Read-JsonFile $script:agentStateFile)
}

function New-AgentState($Saved) {
    $state = [pscustomobject]@{ ports = [pscustomobject]@{} }
    if ($Saved -and $Saved.PSObject.Properties["ports"] -and $Saved.ports) { $state.ports = $Saved.ports }
    return $state
}

function Save-AgentState {
    if (-not $script:agentStateChanged -or -not (Test-StackFolderExists)) { return }
    Write-JsonFile $script:agentStateFile $script:agentState
    $script:agentStateChanged = $false
}

function Test-StackFolderExists { return Test-Path -LiteralPath (Join-Path $script:agentConfig.stackFolder "docker-compose.yml") }

<#
.NOTES
Docker Desktop answers SYSTEM on its default pipe. While Docker is unreachable the stack counts as not
running: its containers cannot be running then either.
#>
function Get-StackContainerStates {
    $result = Invoke-NativeCommand "docker" @("ps", "-a", "--filter", "label=com.docker.compose.project=$script:projectName", "--format", "{{.State}}")
    if ($result.ExitCode -ne 0) { return $null }
    return @($result.Output -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-StackStatus {
    $status = [pscustomobject]@{ dockerReachable = $false; containers = 0; running = 0; folderExists = (Test-StackFolderExists) }
    $states = Get-StackContainerStates
    if ($null -eq $states) { return $status }
    $status.dockerReachable = $true
    $status.containers = @($states).Count
    $status.running = @($states | Where-Object { $_ -in $runningContainerStates }).Count
    return $status
}

function New-JoinedStatus { return [pscustomobject]@{ dockerReachable = $false; containers = 0; running = 0; folderExists = (Test-StackFolderExists) } }

function Get-RoundStatus {
    if ($script:agentMode -eq "joined") { return New-JoinedStatus }
    return Get-StackStatus
}

<#
.NOTES
`up` passes the drives through before it starts the mounter, so a fresh active request counts as the
stack running for a while; a crashed or abandoned `up` still gives the drives back once it is old.
#>
function Test-IsStartingUp($Request) {
    if (-not ($Request -and $Request.active -and $Request.id)) { return $false }
    if (-not $script:requestFirstSeen.ContainsKey($Request.id)) { $script:requestFirstSeen[$Request.id] = Get-Now }
    return ((Get-Now) - $script:requestFirstSeen[$Request.id]).TotalSeconds -lt $requestStartWindowSeconds
}

function Test-StackIsRunning($Status, $Request) {
    if (-not $Status.folderExists) { return $false }
    return $Status.running -gt 0 -or (Test-IsStartingUp $Request)
}

function Update-StackGoneSince([bool]$IsRunning) {
    if ($IsRunning) { $script:stackGoneSince = $null; return }
    if (-not $script:stackGoneSince) { $script:stackGoneSince = Get-Now }
}

function Test-GraceIsOver {
    return $script:stackGoneSince -and ((Get-Now) - $script:stackGoneSince).TotalSeconds -ge $script:stackGraceSeconds
}

function Test-NodeScanIsDue([bool]$VolumeChanged) {
    return $VolumeChanged -or ((Get-Now) - $script:lastNodeScan).TotalSeconds -ge $nodeScanIntervalSeconds
}

function Update-FoundNodes([bool]$VolumeChanged) {
    if (-not (Test-NodeScanIsDue $VolumeChanged)) { return }
    $script:lastNodeScan = Get-Now
    Set-FoundNodes (Find-Nodes (Get-VolumeRoots))
}

function Set-FoundNodes($Found) {
    $before = (@($script:foundNodes.nodes | ForEach-Object { "$($_.id)@$($_.root)" }) -join ",")
    $after = (@($Found.nodes | ForEach-Object { "$($_.id)@$($_.root)" }) -join ",")
    if ($before -ne $after) { Write-WatcherLog "nodes found: $(if ($after) { $after } else { 'none' })" }
    $script:foundNodes = $Found
}

<#
.NOTES
Joined mode reads the node file at each root its joins named instead of scanning volumes: it runs
those nodes and no other. A file that exists but cannot be read still counts as a joined node, so a
file caught mid-write never removes the agent.
#>
function Read-JoinedNodes {
    $found = [pscustomobject]@{ nodes = @(); problems = @(); files = 0 }
    foreach ($entry in $script:joinedNodeEntries) {
        $nodeFile = Get-NodeFilePath $entry.root
        if (-not [System.IO.File]::Exists($nodeFile)) { continue }
        $found.files++
        try { $node = Read-NodeFile $entry.root } catch { $found.problems += New-NodeProblem $nodeFile "$_"; continue }
        $node | Add-Member -NotePropertyName dashboard -NotePropertyValue "$($entry.dashboard)"
        $found.nodes += $node
    }
    return $found
}

function Test-JoinedFetchIsDue { return ((Get-Now) - $script:lastJoinedFetch).TotalSeconds -ge $joinedFetchIntervalSeconds }

function Get-JoinedDeviceId($Node) {
    $key = "$($Node.id)@$($Node.root)"
    if (-not $script:joinedDeviceIds.ContainsKey($key)) {
        $deviceId = Get-SyncthingDeviceId $Node
        if (-not $deviceId) { return $null }
        $script:joinedDeviceIds[$key] = $deviceId
    }
    return $script:joinedDeviceIds[$key]
}

<#
.NOTES
The dashboard is unreachable whenever the tailnet or the dashboard's host is down, so a failure is
logged once, when it starts or changes, and the kept copy stays in use.
#>
function Write-JoinedFetchProblem($Node, [string]$Problem) {
    $previous = $(if ($script:joinedFetchProblems.ContainsKey($Node.id)) { $script:joinedFetchProblems[$Node.id] } else { "" })
    if ($Problem -eq $previous) { return }
    if ($Problem) { Write-WatcherLog "node $($Node.name) ($($Node.id)): no entry from $($Node.dashboard), the kept copy stays: $Problem" }
    $script:joinedFetchProblems[$Node.id] = $Problem
}

function Get-JoinedNodeEntry($Node) {
    $deviceId = Get-JoinedDeviceId $Node
    if (-not $deviceId) { Write-JoinedFetchProblem $Node "its Syncthing has no device ID yet"; return $null }
    try { $text = Get-DashboardEntryText $Node.dashboard (Get-JoinedConnectionsNodeId $deviceId) } catch { Write-JoinedFetchProblem $Node "$_"; return $null }
    $entry = ConvertFrom-ConnectionsText $text
    if (-not $entry) { Write-JoinedFetchProblem $Node "the answer is not an entry"; return $null }
    Write-JoinedFetchProblem $Node ""
    Set-OwnListenPort $entry "$((Get-NodePorts $Node).listen)"
    return $entry
}

function Read-KeptJoinedConnections {
    $kept = Read-ConnectionsFile $script:connectionsFile
    if (Test-IsUnreadableConnections $kept) { return [pscustomobject]@{} }
    return $kept
}

function ConvertTo-EntryKey($Entry) { return ConvertTo-Json -InputObject $Entry -Depth 10 -Compress }

<#
.NOTES
The dashboard cannot reach a joined device's Syncthing API, so a changed entry reaches the running
Syncthing by a restart, which applies it before Syncthing listens again; a deliberate restart is
not a crash and does not count toward the backoff.
#>
function Restart-ForChangedEntry($Node) {
    if (-not $script:syncthingInstances.ContainsKey($Node.id)) { return }
    $instance = $script:syncthingInstances[$Node.id]
    if ($instance.state -ne "running") { return }
    Stop-NodeSyncthing $instance "its connections entry changed; it starts again with it"
    $instance.attempts = @()
}

<#
.NOTES
The entries are kept in joined.json in the shape of the dashboard's connections.json, keyed by node
id, so the start and the firewall read them with the same code as in stack mode.
#>
function Update-JoinedConnections([object[]]$Nodes) {
    if (@($Nodes).Count -eq 0 -or -not (Test-JoinedFetchIsDue)) { return }
    $script:lastJoinedFetch = Get-Now
    $kept = Read-KeptJoinedConnections
    $changed = @()
    foreach ($node in $Nodes) {
        $entry = Get-JoinedNodeEntry $node
        if (-not $entry) { continue }
        if ($kept.PSObject.Properties[$node.id] -and (ConvertTo-EntryKey $kept.($node.id)) -eq (ConvertTo-EntryKey $entry)) { continue }
        $kept | Add-Member -Force -NotePropertyName $node.id -NotePropertyValue $entry
        $changed += $node
    }
    if ($changed.Count -eq 0 -or -not (Test-StackFolderExists)) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path $script:connectionsFile) | Out-Null
    Write-JsonFile $script:connectionsFile $kept
    foreach ($node in $changed) { Restart-ForChangedEntry $node }
}

function Get-PassThroughSummary($PassState) {
    if (-not $PassState) { return [ordered]@{ mode = "none" } }
    return [ordered]@{
        mode = "wsl"; vmBootId = $PassState.vmBootId
        disks = @($PassState.disks | ForEach-Object { [ordered]@{ number = $_.number; model = $_.model; serial = $_.serial; ptuuid = $_.guid; size = $_.size; source = $_.source; attachedAt = $_.attachedAt } })
        problems = @($PassState.problems)
    }
}

<#
.NOTES
The dashboard reads this file (its folder is mounted into the container) and shows "host agent not
running" once `heartbeatEpoch` is 30 s old. Native Syncthings are reached from the container at
host.docker.internal on their GUI port, with the API key published here.
#>
function Get-Heartbeat($Status, [bool]$IsActive, $PassState, [string]$State, [string]$BinaryProblem) {
    $now = Get-Now
    $removesAt = $null
    if ($script:stackGoneSince) { $removesAt = $script:stackGoneSince.AddSeconds($script:stackGraceSeconds).ToString("o") }
    $networks = @(Get-HeartbeatNetworks)
    $problems = @($script:foundNodes.problems)
    if ($BinaryProblem) { $problems += $BinaryProblem }
    $problems += @(Get-LanProblems $networks @($script:syncthingInstances.Values))
    return [ordered]@{
        schema = 1
        heartbeat = $now.ToString("o")
        heartbeatEpoch = [int64]([DateTimeOffset]$now).ToUnixTimeSeconds()
        host = $env:COMPUTERNAME.ToLower()
        os = "windows"
        mode = $script:agentMode
        state = $State
        processId = $PID
        stack = [ordered]@{
            project = $script:projectName; active = $IsActive; dockerReachable = $Status.dockerReachable
            runningContainers = $Status.running; goneSince = $(if ($script:stackGoneSince) { $script:stackGoneSince.ToString("o") } else { $null })
            removesItselfAt = $removesAt
        }
        passThrough = Get-PassThroughSummary $PassState
        networks = $networks
        nodes = @($script:syncthingInstances.Values | ForEach-Object { Get-PublishedInstance $_ })
        foundNodes = @($script:foundNodes.nodes | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name; kind = $_.kind; root = $_.root } })
        problems = $problems
    }
}

function Get-HeartbeatNetworks {
    try { $networks = @(Get-HostNetworks); $problem = $null } catch { $networks = @(); $problem = "$_" }
    Write-NetworksProblemChange $problem
    return $networks
}

<#
.NOTES
A round runs every few seconds, so a lasting failure is logged once, when it starts or changes, and
once more when the networks can be read again.
#>
function Write-NetworksProblemChange([string]$Problem) {
    if ($Problem -eq $script:networksProblem) { return }
    if ($Problem) { Write-WatcherLog "could not read the host's networks: $Problem" } else { Write-WatcherLog "the host's networks can be read again" }
    $script:networksProblem = $Problem
}

function Write-Heartbeat($Heartbeat) {
    if (-not (Test-StackFolderExists)) { return }
    try { Write-JsonFile $script:heartbeatFile $Heartbeat } catch { Write-WatcherLog "could not write the heartbeat: $_" }
}

function Invoke-AgentRound($PassState, [bool]$VolumeChanged) {
    if ($script:agentMode -eq "joined") { Invoke-JoinedRound; return }
    Invoke-StackRound $PassState $VolumeChanged
}

<#
.NOTES
No Docker, no pass-through and no Docker backend rules: a device joined without the stack has none of
them, and the node files are the agent's only tie.
#>
function Invoke-JoinedRound {
    $found = Read-JoinedNodes
    Set-FoundNodes $found
    $script:hasJoinedNodes = $found.files -gt 0
    Update-JoinedConnections $found.nodes
    $binaryProblem = Update-NodeInstances $found.nodes $true
    Save-AgentState
    Write-Heartbeat (Get-Heartbeat (New-JoinedStatus) $script:hasJoinedNodes $null "running" $binaryProblem)
}

function Invoke-StackRound($PassState, [bool]$VolumeChanged) {
    $status = Get-StackStatus
    $request = $null
    if ($status.folderExists) { $request = Read-AttachRequest }
    $isRunning = Test-StackIsRunning $status $request
    Update-StackGoneSince $isRunning
    if ($PassState) { Invoke-WatcherRound $PassState $isRunning }
    Update-FoundNodes $VolumeChanged
    $binaryProblem = Update-NodeInstances $script:foundNodes.nodes $isRunning
    Update-DockerBackendRules $isRunning
    Save-AgentState
    Write-Heartbeat (Get-Heartbeat $status $isRunning $PassState "running" $binaryProblem)
}

<#
.NOTES
RULES.md section 2: a stack that is gone leaves nothing behind outside its folder and Docker, and a
joined device's agent leaves with its last join. The service is marked for deletion and its folder
is removed by a detached command once the service process has exited, since a running executable
cannot delete itself.
#>
function Remove-AgentTraces($PassState) {
    Write-WatcherLog "$(Get-RemovalReason); removing the agent"
    Stop-AllNodeInstances "the agent is removing itself"
    Remove-SyncthingFirewallRules
    if ($PassState) { Remove-AllDisks $PassState }
    Write-Heartbeat (Get-Heartbeat (Get-RoundStatus) $false $PassState "removed" $null)
    Remove-AgentService
}

function Get-RemovalReason {
    if ($script:agentMode -eq "joined") { return "no joined node file is left" }
    return "the stack has been gone for $($script:stackGraceSeconds) s"
}

<#
.NOTES
Joined mode has no grace period (the spec's call 2): the node file is the tie, not a running process,
so a reboot needs none.
#>
function Test-AgentShouldRemoveItself {
    if ($script:agentMode -eq "joined") { return -not $script:hasJoinedNodes }
    return Test-GraceIsOver
}

function Get-AgentPassThrough {
    if ($script:agentMode -eq "joined") { return "none" }
    return $script:agentConfig.passThrough
}

function Get-AgentStartedMessage {
    if ($script:agentMode -eq "joined") { return "agent started in joined mode for $(@($script:joinedNodeEntries | ForEach-Object { $_.root }) -join ', ')" }
    return "agent started for $($script:agentConfig.stackFolder) (project $script:projectName, pass-through $($script:agentConfig.passThrough))"
}

function Remove-AgentService {
    Invoke-NativeCommand "sc.exe" @("delete", $agentServiceName) | Out-Null
    $command = "ping -n 20 127.0.0.1 >nul & rmdir /s /q `"$agentInstallFolder`""
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c $command" -WorkingDirectory $env:SystemRoot -WindowStyle Hidden
}

function Enter-AgentInstance {
    $script:instanceMutex = New-Object System.Threading.Mutex($false, $agentMutexName)
    try { return $script:instanceMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { return $true }
}

function Open-StopSignal([string]$Name) {
    if (-not $Name) { return $null }
    try { return [System.Threading.EventWaitHandle]::OpenExisting($Name) } catch { return $null }
}

function Register-VolumeEvents {
    try { Register-WmiEvent -Class Win32_VolumeChangeEvent -SourceIdentifier $volumeEventName -ErrorAction Stop | Out-Null; return $true }
    catch { Write-WatcherLog "volume events are not available, polling only: $_"; return $false }
}

function Wait-ForNextRound($StopHandle, [bool]$HasVolumeEvents) {
    $volumeChanged = $false
    if ($HasVolumeEvents) {
        $arrival = Wait-Event -SourceIdentifier $volumeEventName -Timeout $agentRoundSeconds
        if ($arrival) { $volumeChanged = $true; Get-Event -SourceIdentifier $volumeEventName -ErrorAction SilentlyContinue | Remove-Event }
    } elseif ($StopHandle) {
        [void]$StopHandle.WaitOne($agentRoundSeconds * 1000)
    } else {
        Start-Sleep -Seconds $agentRoundSeconds
    }
    return [pscustomobject]@{ volumeChanged = $volumeChanged; stopRequested = [bool]($StopHandle -and $StopHandle.WaitOne(0)) }
}

<#
.NOTES
A service stop (a reinstall by `up`, or Windows shutting down) stops the Syncthings but leaves the
drives passed through, so repairing the agent never pulls them from under a running array; `down`
and the removal after the grace period release them.
#>
function Start-Agent {
    Initialize-Agent (Read-AgentConfig $ConfigFile)
    if ((Get-AgentPassThrough) -eq "wsl") { $script:userRelay = Join-Path $PSScriptRoot $agentExecutableName }
    if (-not (Enter-AgentInstance)) { Write-WatcherLog "another agent is running; this one exits"; return }
    $global:OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $stopHandle = Open-StopSignal $StopSignal
    $hasVolumeEvents = Register-VolumeEvents
    $passState = $null
    if ((Get-AgentPassThrough) -eq "wsl") { $passState = New-WatcherState (Read-JsonFile $script:stateFile) }
    Write-WatcherLog (Get-AgentStartedMessage)
    $volumeChanged = $true
    while ($true) {
        try { Invoke-AgentRound $passState $volumeChanged } catch { Write-WatcherLog "round failed: $_" }
        if (Test-AgentShouldRemoveItself) { Remove-AgentTraces $passState; $script:agentExitCode = $agentRemovedItselfExitCode; return }
        $wait = Wait-ForNextRound $stopHandle $hasVolumeEvents
        if ($wait.stopRequested) { break }
        $volumeChanged = $wait.volumeChanged
    }
    Stop-AllNodeInstances "the service is stopping"
    Write-Heartbeat (Get-Heartbeat (Get-RoundStatus) $false $passState "stopped" $null)
    Write-WatcherLog "agent stopped"
}

$agentExitCode = 0
if ($ConfigFile) { Start-Agent | Out-Null; exit $agentExitCode }
