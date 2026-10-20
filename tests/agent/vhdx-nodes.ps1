#Requires -Version 5.1
<#
.SYNOPSIS
End to end on real volumes, in this shell: two VHDX test volumes, one a drive node and one holding a
folder node through its index (the Ventoy stick's layout), are attached and detached while the
agent's own loop runs, with real volume events and the real pinned Syncthing. Docker is faked as a
running stack and the firewall is faked; the ports are moved away from the agent's own. Needs an
admin shell (diskpart); leaves nothing behind.
#>
param([Parameter(Mandatory = $true)][string]$SyncthingPath)

Set-StrictMode -Version Latest
$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")
. (Join-Path $PSScriptRoot "test-volumes.ps1")

$syncthingGuiPortBase = 18460
$syncthingListenPortBase = 32110
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-vhdx-$([guid]::NewGuid())"
$stackFolder = Join-Path $scratch "stack"
$driveVhdx = Join-Path $scratch "drive-node.vhdx"
$stickVhdx = Join-Path $scratch "stick.vhdx"
$script:passed = 0
$script:failed = 0

function Get-StackContainerStates { return @("running") }
function Get-TailnetAddress { return $null }
function Set-SyncthingFirewallRule($Node, $Ports) { }
function Remove-NetFirewallRule { }
function Remove-SyncthingFirewallRules { }

function Test-Expectation([string]$What, $Expected, $Actual) {
    if ("$Expected" -eq "$Actual") { Write-Host "  PASS $What`: $Actual" -ForegroundColor Green; $script:passed++ }
    else { Write-Host "  FAIL $What`: expected '$Expected', got '$Actual'" -ForegroundColor Red; $script:failed++ }
}

function Read-TestHeartbeat { return Read-JsonFile (Join-Path $stackFolder "host-agent\status\heartbeat.json") }

function Get-RunningNodeIds {
    $heartbeat = Read-TestHeartbeat
    return (@($heartbeat.nodes | Where-Object { $_.syncthing.state -eq "running" } | ForEach-Object { $_.id } | Sort-Object) -join ",")
}

<#
.NOTES
Runs the agent's own wait and round until the condition holds, so a pass shows the volume event (or
the slow poll) did the work, and how long it took.
#>
function Invoke-RoundsUntil([scriptblock]$Condition, [int]$Seconds, [string]$What) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $sawEvent = $false
    while ($watch.Elapsed.TotalSeconds -lt $Seconds) {
        $wait = Wait-ForNextRound $null $script:hasEvents
        if ($wait.volumeChanged) { $sawEvent = $true }
        Invoke-AgentRound $null $wait.volumeChanged
        if (& $Condition) { Write-Host "  ($What after $([int]$watch.Elapsed.TotalSeconds) s, volume event seen: $sawEvent)"; return $sawEvent }
    }
    return $sawEvent
}

function Invoke-Api($Published, [string]$Path) {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$($Published.syncthing.guiPort)$Path" -Headers @{ "X-API-Key" = $Published.syncthing.apiKey } -TimeoutSec 5 -UseBasicParsing
}

function Wait-ForApi($Published) {
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) { try { $status = Invoke-Api $Published "/rest/system/status"; if ($status.PSObject.Properties["myID"]) { return $status } } catch { }; Start-Sleep -Milliseconds 500 }
    return $null
}

try {
    New-Item -ItemType Directory -Force -Path $stackFolder | Out-Null
    Set-Content -Path (Join-Path $stackFolder "docker-compose.yml") -Value "name: storage-compose"
    Write-Host "Making the test volumes..." -ForegroundColor Cyan
    $driveRoot = New-TestVolume $driveVhdx "agentdrive"
    Write-TestNodeFile $driveRoot "d1e2" "test-drive" "drive"
    $stickRoot = New-TestVolume $stickVhdx "agentstick"
    New-Item -ItemType Directory -Force -Path (Join-Path $stickRoot "ventoy") | Out-Null
    Write-TestNodeFile (Join-Path $stickRoot "ventoy") "ffff" "not-listed" "folder"
    New-Item -ItemType Directory -Force -Path (Join-Path $stickRoot ".storage") | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $stickRoot ".storage\nodes.toml"), "paths = [`"files`"]`n")
    Write-TestNodeFile (Join-Path $stickRoot "files") "5a1c" "test-stick-files" "folder"
    Dismount-TestVolume $stickVhdx

    $config = [pscustomobject]@{
        stackFolder = $stackFolder; projectName = "storage-agent-test"; userSid = "S-1-5-21-0"; passThrough = "none"
        syncthingPath = $SyncthingPath; syncthingSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $SyncthingPath).Hash.ToLower()
    }
    Initialize-Agent $config
    $script:hasEvents = Register-VolumeEvents
    Test-Expectation "volume events registered" $true $script:hasEvents

    Write-Host "The drive node, present from the start:" -ForegroundColor Cyan
    Invoke-AgentRound $null $true
    Test-Expectation "nodes running" "d1e2" (Get-RunningNodeIds)
    $drive = @((Read-TestHeartbeat).nodes)[0]
    Test-Expectation "Syncthing's home is on the drive node" (Join-Path $driveRoot ".storage\syncthing") $drive.syncthing.home
    $status = Wait-ForApi $drive
    Test-Expectation "the API answers with the published key" $drive.syncthing.deviceId $(if ($status) { $status.myID } else { "no answer" })

    Write-Host "The stick arrives:" -ForegroundColor Cyan
    $stickRoot = Mount-TestVolume $stickVhdx
    $sawArrival = Invoke-RoundsUntil { (Get-RunningNodeIds) -eq "5a1c,d1e2" } 40 "found"
    Test-Expectation "nodes running" "5a1c,d1e2" (Get-RunningNodeIds)
    Test-Expectation "found by the volume event, before the slow poll" $true $sawArrival
    $stick = @((Read-TestHeartbeat).nodes | Where-Object { $_.id -eq "5a1c" })[0]
    Test-Expectation "the folder node runs in the listed folder" (Join-Path $stickRoot "files") $stick.root
    Test-Expectation "the unlisted folder is not a node" "" (@((Read-TestHeartbeat).foundNodes | Where-Object { $_.id -eq "ffff" }).Count -replace '^0$', '')
    Test-Expectation "its own ports" "18461" $stick.syncthing.guiPort
    $stickStatus = Wait-ForApi $stick
    Test-Expectation "the stick's Syncthing answers" $stick.syncthing.deviceId $(if ($stickStatus) { $stickStatus.myID } else { "no answer" })

    Write-Host "The stick is pulled while its Syncthing runs:" -ForegroundColor Cyan
    Dismount-TestVolume $stickVhdx
    Invoke-RoundsUntil { (Get-RunningNodeIds) -eq "d1e2" } 40 "dropped" | Out-Null
    Test-Expectation "nodes running" "d1e2" (Get-RunningNodeIds)

    Write-Host "The stick comes back and keeps its identity and ports:" -ForegroundColor Cyan
    $stickRoot = Mount-TestVolume $stickVhdx
    Invoke-RoundsUntil { (Get-RunningNodeIds) -eq "5a1c,d1e2" } 40 "found again" | Out-Null
    $back = @((Read-TestHeartbeat).nodes | Where-Object { $_.id -eq "5a1c" })[0]
    Test-Expectation "same device ID" $stick.syncthing.deviceId $back.syncthing.deviceId
    Test-Expectation "same GUI port" $stick.syncthing.guiPort $back.syncthing.guiPort

    Write-Host "The stack stops:" -ForegroundColor Cyan
    function Get-StackContainerStates { return @("exited") }
    Invoke-AgentRound $null $false
    Test-Expectation "nodes running" "" (Get-RunningNodeIds)
    Test-Expectation "Syncthing processes left" 0 @(Get-SyncthingProcesses).Count
} finally {
    Stop-AllNodeInstances "test cleanup"
    Unregister-Event -SourceIdentifier $volumeEventName -ErrorAction SilentlyContinue
    Remove-TestVolume $stickVhdx
    Remove-TestVolume $driveVhdx
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}
Write-Host ""
Write-Host "VHDX nodes: $script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
