#Requires -Version 5.1
<#
.SYNOPSIS
The storage-compose host agent on Windows (specs/2026-10-19-storage-nodes-and-dashboard-design.md, the
host agent and its lifetime, and specs/2026-11-03-host-agent-joined-mode-design.md). In stack mode it
passes the array's drives through to WSL, runs one native Syncthing per drive or folder node it finds,
and writes a heartbeat for the dashboard, all only while the stack's containers run or wait out a
stop of Docker itself, and removes itself ten minutes after the stack is gone. In joined mode, on a
device joined without the stack, it runs the Syncthing of each node its joins named while that node's
file exists, with the entry fetched
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
$joinedFetchBudgetSeconds = 10
$stackGraceSeconds = 600
$requestStartWindowSeconds = 600
$dockerStopWindowSeconds = 120
$dockerWaitMaxSeconds = 86400
$dockerClockIntervalSeconds = 60
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
$lastJoinedNodes = @{}
$joinedNodeProblems = @{}
$binaryProblem = ""
$dockerWaitReason = ""
$lastDockerClockRead = [datetime]::MinValue
$dockerClockOffsetSeconds = $null
$stoppedWithDockerKey = $null

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

<#
.NOTES
dockerAnsweredAt (host clock) and dockerAnsweredVmAt (the VM's clock) are kept in memory every round
and written with the rest of the state, and at a service stop, so an agent that starts again during a
Docker outage (a reboot) still knows when Docker last answered. A saved value of the wrong shape is
dropped rather than trusted, since a bad time would decide whether the host's Syncthings stop.
#>
function New-AgentState($Saved) {
    $state = [pscustomobject]@{ ports = [pscustomobject]@{}; dockerAnsweredAt = $null; dockerAnsweredVmAt = $null; dockerOutage = $null }
    if (-not $Saved) { return $state }
    if ($Saved.PSObject.Properties["ports"] -and $Saved.ports) { $state.ports = $Saved.ports }
    $dropped = @()
    foreach ($name in @("dockerAnsweredAt", "dockerAnsweredVmAt", "dockerOutage")) {
        if (-not ($Saved.PSObject.Properties[$name] -and $Saved.$name)) { continue }
        $isValid = $(if ($name -eq "dockerOutage") { Test-IsSavedOutage $Saved.$name } else { Test-IsSavedTime $Saved.$name })
        if ($isValid) { $state.$name = $Saved.$name } else { $dropped += $name }
    }
    if ($dropped.Count -gt 0) { Write-WatcherLog "$agentStateName had an unreadable $($dropped -join ', '); the agent starts without it" }
    return $state
}

function Test-IsSavedTime($Value) {
    if (-not ($Value -and $Value.PSObject.BaseObject -is [string])) { return $false }
    try { return [bool](ConvertFrom-SavedTime $Value) } catch { return $false }
}

function Test-IsSavedOutage($Value) {
    if (-not ($Value -and $Value.PSObject.BaseObject -is [System.Management.Automation.PSCustomObject])) { return $false }
    if (-not ($Value.PSObject.Properties["noticedAt"] -and (Test-IsSavedTime $Value.noticedAt))) { return $false }
    foreach ($name in @("lastAnsweredAt", "lastAnsweredVmAt")) {
        if ($Value.PSObject.Properties[$name] -and $Value.$name -and -not (Test-IsSavedTime $Value.$name)) { return $false }
    }
    return $true
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
running (its containers cannot be running then either), and the agent waits for Docker
(Update-DockerWait). $null means exactly that, so an empty list is returned wrapped: PowerShell
unrolls an empty array to $null, which read a removed stack as Docker not answering.
#>
function Get-StackContainers {
    $result = Invoke-NativeCommand "docker" @("ps", "-a", "--filter", "label=com.docker.compose.project=$script:projectName", "--format", "{{.ID}} {{.State}}")
    if ($result.ExitCode -ne 0) { return $null }
    return ,@(Split-OutputLines $result.Output | ForEach-Object { $id, $state = $_ -split " ", 2; [pscustomobject]@{ id = $id; state = "$state" } })
}

function Split-OutputLines([string]$Output) { return @($Output -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

function Test-DockerIsInstalled { return [bool](Get-Command "docker" -CommandType Application -ErrorAction SilentlyContinue) }

<#
.NOTES
Throws when Docker does not answer, so a failed question never reads as a stack whose containers
never ran.
#>
function Get-StackLastFinishedAt([string[]]$Ids) {
    if (@($Ids).Count -eq 0) { return $null }
    $times = Invoke-NativeCommand "docker" (@("inspect", "--format", "{{.State.FinishedAt}}") + $Ids)
    if ($times.ExitCode -ne 0) { throw "docker inspect did not answer: $($times.Output)" }
    $finished = @(Split-OutputLines $times.Output | ForEach-Object { ConvertFrom-DockerTime $_ } | Where-Object { $_ })
    if ($finished.Count -eq 0) { return $null }
    return ($finished | Sort-Object | Select-Object -Last 1)
}

function Get-DockerSystemTime {
    $result = Invoke-NativeCommand "docker" @("info", "--format", "{{.SystemTime}}")
    if ($result.ExitCode -ne 0) { throw "docker info did not answer: $($result.Output)" }
    return ConvertFrom-DockerTime $result.Output
}

<#
.NOTES
Docker writes nanoseconds, which .NET does not parse past seven digits, and 0001-01-01 for a
container that never finished.
#>
function ConvertFrom-DockerTime([string]$Text) {
    if (-not $Text -or $Text.StartsWith("0001-")) { return $null }
    $trimmed = $Text -replace '(\.\d{7})\d+', '$1'
    return [DateTimeOffset]::Parse($trimmed, [System.Globalization.CultureInfo]::InvariantCulture).LocalDateTime
}

function ConvertFrom-SavedTime($Text) {
    if (-not $Text) { return $null }
    return [datetime]::Parse("$Text", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
}

function New-StackStatus {
    return [pscustomobject]@{ dockerReachable = $false; dockerInstalled = $true; containers = 0; containerIds = @(); running = 0; folderExists = (Test-StackFolderExists); waitingForDocker = $false }
}

function Get-StackStatus {
    $status = New-StackStatus
    $containers = Get-StackContainers
    if ($null -eq $containers) { $status.dockerInstalled = Test-DockerIsInstalled; return $status }
    $status.dockerReachable = $true
    $status.containers = @($containers).Count
    $status.containerIds = @($containers | ForEach-Object { $_.id } | Sort-Object)
    $status.running = @($containers | Where-Object { $_.state -in $runningContainerStates }).Count
    return $status
}

function New-JoinedStatus { return New-StackStatus }

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

<#
.NOTES
A Docker Desktop restart kills every container and leaves the stack exited until `up`. That is not
a shutdown, so it must not start the grace that ends with the host's Syncthings stopped: while Docker
does not answer, or the stack's containers exited with Docker's own stop, the native nodes keep
running (the drives and Docker's own rules follow the containers, as for any stop). The agent judges
this from what it saw itself, since Docker reports no start or stop time of its own: containers that
Docker's stop took down finished at most $dockerStopWindowSeconds before Docker last answered, on the
VM's clock, while a `docker stop`, `compose stop` or `down` leaves Docker answering for longer. An
unknown or unreadable last answer counts as Docker's stop. The wait ends after
$dockerWaitMaxSeconds, and a host with no docker command has no Docker to wait for.
#>
function Update-DockerWait($Status, [bool]$IsRunning) {
    if ($Status.dockerReachable) { Write-DockerAnswer }
    $reason = Get-DockerWaitReason $Status $IsRunning
    if ($reason -eq "unreachable" -and -not $script:agentState.dockerOutage) { Open-DockerOutage }
    if (-not $reason -and $Status.dockerReachable -and $script:agentState.dockerOutage) { Set-DockerOutage $null }
    Write-DockerWaitChange $reason $IsRunning
    return $reason -in @("unreachable", "stopped with Docker")
}

<#
.NOTES
The VM's clock is read at most once a minute: asking every round would double the round's Docker
calls, and the clocks drift apart over hours (after a sleep), not seconds.
#>
function Write-DockerAnswer {
    $now = Get-Now
    $script:agentState.dockerAnsweredAt = $now.ToString("o")
    if (($now - $script:lastDockerClockRead).TotalSeconds -ge $dockerClockIntervalSeconds) {
        $script:lastDockerClockRead = $now
        try { $script:dockerClockOffsetSeconds = ((Get-DockerSystemTime) - $now).TotalSeconds } catch { $script:dockerClockOffsetSeconds = $null }
    }
    $script:agentState.dockerAnsweredVmAt = $(if ($null -ne $script:dockerClockOffsetSeconds) { $now.AddSeconds($script:dockerClockOffsetSeconds).ToString("o") } else { $null })
}

function Open-DockerOutage {
    Set-DockerOutage ([pscustomobject]@{
        lastAnsweredAt = $script:agentState.dockerAnsweredAt; lastAnsweredVmAt = $script:agentState.dockerAnsweredVmAt
        noticedAt = (Get-Now).ToString("o")
    })
}

function Get-DockerWaitReason($Status, [bool]$IsRunning) {
    if ($IsRunning -or -not $Status.folderExists) { return "" }
    if (-not $Status.dockerReachable -and -not $Status.dockerInstalled) { return "no Docker" }
    $outage = $script:agentState.dockerOutage
    if ($outage -and (Test-DockerWaitIsOver $outage)) { return "waited out" }
    if (-not $Status.dockerReachable) { return "unreachable" }
    if ($outage -and (Test-StackStoppedWithDocker $Status)) { return "stopped with Docker" }
    return ""
}

function Test-DockerWaitIsOver($Outage) {
    try { $noticedAt = ConvertFrom-SavedTime $Outage.noticedAt } catch { return $true }
    return ((Get-Now) - $noticedAt).TotalSeconds -ge $dockerWaitMaxSeconds
}

<#
.NOTES
A true answer holds for the outage while the same containers stay, so a long wait asks Docker
nothing more; a container removed or added asks again.
#>
function Test-StackStoppedWithDocker($Status) {
    if ($Status.containers -eq 0) { return $false }
    $key = "$($script:agentState.dockerOutage.noticedAt)|$(@($Status.containerIds) -join ',')"
    if ($script:stoppedWithDockerKey -eq $key) { return $true }
    $isStopped = Test-FinishedWithDockerStop $Status
    $script:stoppedWithDockerKey = $(if ($isStopped) { $key } else { $null })
    return $isStopped
}

function Test-FinishedWithDockerStop($Status) {
    try {
        $finishedAt = Get-StackLastFinishedAt $Status.containerIds
        if (-not $finishedAt) { return $false }
        $outage = $script:agentState.dockerOutage
        $answeredAt = $(if ($outage.PSObject.Properties["lastAnsweredVmAt"] -and $outage.lastAnsweredVmAt) { ConvertFrom-SavedTime $outage.lastAnsweredVmAt } else { ConvertFrom-SavedTime $outage.lastAnsweredAt })
        if (-not $answeredAt) { return $true }
        return $finishedAt -ge $answeredAt.AddSeconds(-$dockerStopWindowSeconds)
    } catch {
        return $true
    }
}

function Set-DockerOutage($Outage) {
    $script:agentState.dockerOutage = $Outage
    $script:agentStateChanged = $true
}

function Write-DockerWaitChange([string]$Reason, [bool]$IsRunning) {
    if ($Reason -eq $script:dockerWaitReason) { return }
    if ($Reason -eq "unreachable") { Write-WatcherLog "Docker does not answer; the nodes keep running and the grace period waits for Docker" }
    elseif ($Reason -eq "stopped with Docker") { Write-WatcherLog "the stack's containers exited with Docker's own stop; the nodes keep running until the stack runs again or is shut down" }
    elseif ($Reason -eq "waited out") { Write-WatcherLog "waited $dockerWaitMaxSeconds s for Docker; the stack counts as gone and the grace period counts" }
    elseif ($Reason -eq "no Docker") { Write-WatcherLog "no docker command on this host; the stack counts as gone and the grace period counts" }
    elseif ($IsRunning) { Write-WatcherLog "no longer waiting for Docker: the stack runs" }
    else { Write-WatcherLog "no longer waiting for Docker: the stack was stopped or removed while Docker ran; the grace period counts" }
    $script:dockerWaitReason = $Reason
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
those nodes and no other. Only a deleted file (Get-NodeFileState "gone") drops a node. A root whose
volume or folder cannot be seen still counts as joined and runs nothing until it returns; a file
that is there but cannot be opened or read keeps the node as it was last read, so a file caught
mid-write never stops its Syncthing. allKnown says whether every joined node's id is known this
round, which pruning the kept entries needs.
#>
function Read-JoinedNodes {
    $found = [pscustomobject]@{ nodes = @(); problems = @(); files = 0; allKnown = $true }
    foreach ($entry in $script:joinedNodeEntries) {
        $state = Get-NodeFileState $entry.root
        if ($state -eq "gone") {
            $script:lastJoinedNodes.Remove($entry.root)
            Write-JoinedNodeProblem $entry.root ""
            continue
        }
        $found.files++
        $node = $null
        if ($state -eq "unreachable") { Write-JoinedNodeProblem $entry.root (Get-UnreachableJoinedProblem $entry.root) }
        else { $node = Read-JoinedNode $entry $state }
        if ($node) { $found.nodes += $node } else { $found.allKnown = $false }
        $problem = $script:joinedNodeProblems[$entry.root]
        if ($problem) { $found.problems += New-NodeProblem (Get-NodeFilePath $entry.root) $problem }
    }
    return $found
}

<#
.NOTES
A volume that is there while the root or its .storage folder is not is most likely a folder that was
moved or deleted rather than a drive still on its way, so the log names the way out.
#>
function Get-UnreachableJoinedProblem([string]$Root) {
    $volume = [System.IO.Path]::GetPathRoot($Root)
    if ($volume -and [System.IO.Directory]::Exists($volume)) {
        return "its folder or its .storage folder is missing while its volume is there; the agent keeps it, running nothing for it, until storage-join.ps1 -Leave or the folder returns"
    }
    return "its volume cannot be seen; nothing runs for it until it returns"
}

function Read-JoinedNode($Entry, [string]$State) {
    try {
        if ($State -ne "present") { throw "it is there but cannot be opened" }
        $node = Read-NodeFile $Entry.root
        $node | Add-Member -NotePropertyName dashboard -NotePropertyValue "$($Entry.dashboard)"
        $script:lastJoinedNodes[$Entry.root] = $node
        Write-JoinedNodeProblem $Entry.root ""
        return $node
    } catch {
        $last = $script:lastJoinedNodes[$Entry.root]
        Write-JoinedNodeProblem $Entry.root $(if ($last) { "kept running as last read: $_" } else { "$_" })
        return $last
    }
}

function Write-JoinedNodeProblem([string]$Root, [string]$Problem) {
    $previous = "$($script:joinedNodeProblems[$Root])"
    if ($Problem -eq $previous) { return }
    if ($Problem) { Write-WatcherLog "joined node at $Root`: $Problem" } else { Write-WatcherLog "joined node at $Root can be read again" }
    $script:joinedNodeProblems[$Root] = $Problem
}

<#
.NOTES
Only while every joined node's id is known: a node whose volume is away keeps its kept entry for
when it returns.
#>
function Remove-LeftJoinedEntries($Found) {
    if (-not $Found.allKnown -or -not (Test-StackFolderExists)) { return }
    $kept = Read-KeptJoinedConnections
    $ids = @($Found.nodes | ForEach-Object { $_.id })
    $left = @($kept.PSObject.Properties | Where-Object { $ids -notcontains $_.Name } | ForEach-Object { $_.Name })
    if ($left.Count -eq 0) { return }
    foreach ($id in $left) { $kept.PSObject.Properties.Remove($id) }
    Write-JsonFile $script:connectionsFile $kept
    Write-WatcherLog "dropped the kept entries of nodes that left: $($left -join ', ')"
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

function Get-JoinedNodeEntry($Node, [double]$TimeoutSeconds) {
    $deviceId = Get-JoinedDeviceId $Node
    if (-not $deviceId) { Write-JoinedFetchProblem $Node "its Syncthing has no device ID yet"; return $null }
    try { $text = Get-DashboardEntryText $Node.dashboard (Get-JoinedConnectionsNodeId $deviceId) $TimeoutSeconds } catch { Write-JoinedFetchProblem $Node "$_"; return $null }
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

<#
.NOTES
The contract the restart rests on: a kept entry (read back from joined.json) and the same entry
fetched again (parsed from the dashboard's answer, then moved to the node's port) give the same key,
so an entry that did not change never restarts a Syncthing.
#>
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
id, so the start and the firewall read them with the same code as in stack mode. One round spends
at most $joinedFetchBudgetSeconds on fetching, however many nodes there are; a node not asked in
time is asked at the next fetch.
#>
function Update-JoinedConnections([object[]]$Nodes) {
    if (@($Nodes).Count -eq 0 -or -not (Test-JoinedFetchIsDue)) { return }
    $script:lastJoinedFetch = Get-Now
    $kept = Read-KeptJoinedConnections
    $changed = @()
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($node in $Nodes) {
        $left = $joinedFetchBudgetSeconds - $clock.Elapsed.TotalSeconds
        if ($left -le 0) { Write-JoinedFetchProblem $node "not asked: this round's $joinedFetchBudgetSeconds s for entries ran out"; continue }
        $entry = Get-JoinedNodeEntry $node $left
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
            waitingForDocker = $Status.waitingForDocker
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

<#
.NOTES
A missing or changed binary lasts until someone acts: in joined mode it is the checkout that
installed the agent being moved or deleted. It is in every heartbeat and logged once, when it starts
or changes.
#>
function Write-BinaryProblemChange([string]$Problem) {
    if ($Problem -eq $script:binaryProblem) { return }
    if ($Problem) { Write-WatcherLog "no node's Syncthing runs: $Problem" } else { Write-WatcherLog "Syncthing's binary is in place again" }
    $script:binaryProblem = $Problem
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
    Remove-LeftJoinedEntries $found
    $binaryProblem = Update-NodeInstances $found.nodes $true
    Write-BinaryProblemChange $binaryProblem
    Update-JoinedConnections $found.nodes
    Save-AgentState
    Write-Heartbeat (Get-Heartbeat (New-JoinedStatus) $script:hasJoinedNodes $null "running" $binaryProblem)
}

function Invoke-StackRound($PassState, [bool]$VolumeChanged) {
    $status = Get-StackStatus
    $request = $null
    if ($status.folderExists) { $request = Read-AttachRequest }
    $isRunning = Test-StackIsRunning $status $request
    $status.waitingForDocker = Update-DockerWait $status $isRunning
    $isActive = $isRunning -or $status.waitingForDocker
    Update-StackGoneSince $isActive
    if ($PassState) { Invoke-WatcherRound $PassState $isRunning }
    Update-FoundNodes $VolumeChanged
    $binaryProblem = Update-NodeInstances $script:foundNodes.nodes $isActive
    Write-BinaryProblemChange $binaryProblem
    Update-DockerBackendRules $isRunning
    Save-AgentState
    Write-Heartbeat (Get-Heartbeat $status $isActive $PassState "running" $binaryProblem)
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

function Get-StayingJoinedNodes { return @($script:joinedNodeEntries | Where-Object { (Get-NodeFileState $_.root) -ne "gone" }) }

function ConvertTo-JoinedConfig($Config, [object[]]$JoinedNodes) {
    $joined = ConvertTo-Json -InputObject $Config -Depth 10 | ConvertFrom-Json
    $joined.projectName = ""
    $joined.passThrough = "none"
    $joined | Add-Member -Force -NotePropertyName graceSeconds -NotePropertyValue 0
    $joined | Add-Member -Force -NotePropertyName joinedNodes -NotePropertyValue @($JoinedNodes | ForEach-Object { [pscustomobject][ordered]@{ root = "$($_.root)"; dashboard = "$($_.dashboard)" } })
    return $joined
}

<#
.NOTES
The stack-mode removal while a carried joined node is still there ends where `down`'s hand-back
does: what the stack added goes (its Syncthings, every rule of the agent's group with the Docker
backend's, the passed-through drives), the config on disk becomes joined mode's, and the agent goes
on in joined mode without unregistering.
#>
function Switch-ToJoinedMode($PassState) {
    if ($script:agentMode -ne "stack") { return $false }
    $staying = @(Get-StayingJoinedNodes)
    if ($staying.Count -eq 0) { return $false }
    Write-WatcherLog "the stack has been gone for $($script:stackGraceSeconds) s; switching to joined mode for $(@($staying | ForEach-Object { $_.root }) -join ', ')"
    Stop-AllNodeInstances "the stack is gone; the agent switches to joined mode"
    if ($PassState) { Remove-AllDisks $PassState }
    $joined = ConvertTo-JoinedConfig $script:agentConfig $staying
    Write-JsonFile $ConfigFile $joined
    Initialize-Agent $joined
    $script:stackGoneSince = $null
    $script:hasJoinedNodes = $true
    $script:lastJoinedFetch = [datetime]::MinValue
    $script:userRelay = $null
    return $true
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
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c $(Get-AgentFolderRemovalCommand)" -WorkingDirectory $env:SystemRoot -WindowStyle Hidden
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
        if (Test-AgentShouldRemoveItself) {
            if (Switch-ToJoinedMode $passState) { $passState = $null; $volumeChanged = $true; continue }
            Remove-AgentTraces $passState; $script:agentExitCode = $agentRemovedItselfExitCode; return
        }
        $wait = Wait-ForNextRound $stopHandle $hasVolumeEvents
        if ($wait.stopRequested) { break }
        $volumeChanged = $wait.volumeChanged
    }
    Stop-AllNodeInstances "the service is stopping"
    $script:agentStateChanged = $true
    Save-AgentState
    Write-Heartbeat (Get-Heartbeat (Get-RoundStatus) $false $passState "stopped" $null)
    Write-WatcherLog "agent stopped"
}

$agentExitCode = 0
if ($ConfigFile) { Start-Agent | Out-Null; exit $agentExitCode }
