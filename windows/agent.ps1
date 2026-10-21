#Requires -Version 5.1
<#
.SYNOPSIS
The storage-compose host agent on Windows (specs/2026-10-19-storage-nodes-and-dashboard-design.md, the
host agent and its lifetime): passes the array's drives through to WSL, runs one native Syncthing per
drive or folder node it finds, and writes a heartbeat for the dashboard, all only while the stack's
containers run. Ten minutes after the stack is gone it removes itself. Run as SYSTEM by the
storage-compose-agent service; started without -ConfigFile it only defines its functions (the tests
use that).
#>
param([string]$ConfigFile, [string]$StopSignal)

Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "agent-files.ps1")
. (Join-Path $PSScriptRoot "passthrough.ps1")
. (Join-Path $PSScriptRoot "nodes.ps1")
. (Join-Path $PSScriptRoot "syncthing.ps1")

$agentRoundSeconds = 5
$nodeScanIntervalSeconds = 60
$stackGraceSeconds = 600
$requestStartWindowSeconds = 600
$volumeEventName = "storage-compose-volume-change"
$runningContainerStates = @("running", "restarting")

$agentConfig = $null
$agentState = $null
$agentStateChanged = $false
$stackGoneSince = $null
$requestFirstSeen = @{}
$lastNodeScan = [datetime]::MinValue
$foundNodes = [pscustomobject]@{ nodes = @(); problems = @() }

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
    $found = Find-Nodes (Get-VolumeRoots)
    $before = (@($script:foundNodes.nodes | ForEach-Object { "$($_.id)@$($_.root)" }) -join ",")
    $after = (@($found.nodes | ForEach-Object { "$($_.id)@$($_.root)" }) -join ",")
    if ($before -ne $after) { Write-WatcherLog "nodes found: $(if ($after) { $after } else { 'none' })" }
    $script:foundNodes = $found
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
    $problems = @($script:foundNodes.problems)
    if ($BinaryProblem) { $problems += $BinaryProblem }
    return [ordered]@{
        schema = 1
        heartbeat = $now.ToString("o")
        heartbeatEpoch = [int64]([DateTimeOffset]$now).ToUnixTimeSeconds()
        host = $env:COMPUTERNAME.ToLower()
        os = "windows"
        state = $State
        processId = $PID
        stack = [ordered]@{
            project = $script:projectName; active = $IsActive; dockerReachable = $Status.dockerReachable
            runningContainers = $Status.running; goneSince = $(if ($script:stackGoneSince) { $script:stackGoneSince.ToString("o") } else { $null })
            removesItselfAt = $removesAt
        }
        passThrough = Get-PassThroughSummary $PassState
        nodes = @($script:syncthingInstances.Values | ForEach-Object { Get-PublishedInstance $_ })
        foundNodes = @($script:foundNodes.nodes | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name; kind = $_.kind; root = $_.root } })
        problems = $problems
    }
}

function Write-Heartbeat($Heartbeat) {
    if (-not (Test-StackFolderExists)) { return }
    try { Write-JsonFile $script:heartbeatFile $Heartbeat } catch { Write-WatcherLog "could not write the heartbeat: $_" }
}

function Invoke-AgentRound($PassState, [bool]$VolumeChanged) {
    $status = Get-StackStatus
    $request = $null
    if ($status.folderExists) { $request = Read-AttachRequest }
    $isRunning = Test-StackIsRunning $status $request
    Update-StackGoneSince $isRunning
    if ($PassState) { Invoke-WatcherRound $PassState $isRunning }
    Update-FoundNodes $VolumeChanged
    $binaryProblem = Update-NodeInstances $script:foundNodes.nodes $isRunning
    Save-AgentState
    Write-Heartbeat (Get-Heartbeat $status $isRunning $PassState "running" $binaryProblem)
}

<#
.NOTES
RULES.md section 2: a stack that is gone leaves nothing behind outside its folder and Docker. The
service is marked for deletion and its folder is removed by a detached command once the service
process has exited, since a running executable cannot delete itself.
#>
function Remove-AgentTraces($PassState) {
    Write-WatcherLog "the stack has been gone for $($script:stackGraceSeconds) s; removing the agent"
    Stop-AllNodeInstances "the agent is removing itself"
    Remove-SyncthingFirewallRules
    if ($PassState) { Remove-AllDisks $PassState }
    Write-Heartbeat (Get-Heartbeat (Get-StackStatus) $false $PassState "removed" $null)
    Remove-AgentService
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
    if ($agentConfig.passThrough -eq "wsl") { $script:userRelay = Join-Path $PSScriptRoot $agentExecutableName }
    if (-not (Enter-AgentInstance)) { Write-WatcherLog "another agent is running; this one exits"; return }
    $global:OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $stopHandle = Open-StopSignal $StopSignal
    $hasVolumeEvents = Register-VolumeEvents
    $passState = $null
    if ($agentConfig.passThrough -eq "wsl") { $passState = New-WatcherState (Read-JsonFile $script:stateFile) }
    Write-WatcherLog "agent started for $($agentConfig.stackFolder) (project $script:projectName, pass-through $($agentConfig.passThrough))"
    $volumeChanged = $true
    while ($true) {
        try { Invoke-AgentRound $passState $volumeChanged } catch { Write-WatcherLog "round failed: $_" }
        if (Test-GraceIsOver) { Remove-AgentTraces $passState; $script:agentExitCode = $agentRemovedItselfExitCode; return }
        $wait = Wait-ForNextRound $stopHandle $hasVolumeEvents
        if ($wait.stopRequested) { break }
        $volumeChanged = $wait.volumeChanged
    }
    Stop-AllNodeInstances "the service is stopping"
    Write-Heartbeat (Get-Heartbeat (Get-StackStatus) $false $passState "stopped" $null)
    Write-WatcherLog "agent stopped"
}

$agentExitCode = 0
if ($ConfigFile) { Start-Agent | Out-Null; exit $agentExitCode }
