#Requires -Version 5.1
<#
.SYNOPSIS
A stick as an offline seed on real volumes, in this shell: a VHDX stick node at threshold 80 holding the essential
folder seeds a VHDX host node over this device (loopback) with no tailnet, and the rest arrives once a third
volume's node, standing in for a keeper, is made reachable to it. The agent's own loop runs the two volumes' Syncthings; Docker is
faked as a running stack and the firewall is faked; the ports are moved away from the agent's own. Needs an admin
shell (diskpart); leaves nothing behind.
#>
param([Parameter(Mandatory = $true)][string]$SyncthingPath)

Set-StrictMode -Version Latest
$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")
. (Join-Path $PSScriptRoot "test-volumes.ps1")

$syncthingGuiPortBase = 18480
$syncthingListenPortBase = 32150
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-seed-$([guid]::NewGuid())"
$stackFolder = Join-Path $scratch "stack"
$stickVhdx = Join-Path $scratch "seed-stick.vhdx"
$hostVhdx = Join-Path $scratch "seed-host.vhdx"
$keeperVhdx = Join-Path $scratch "seed-keeper.vhdx"
$testVhdxPaths = @($stickVhdx, $hostVhdx, $keeperVhdx)
$script:passed = 0
$script:failed = 0

function Get-StackContainers { return ,@([pscustomobject]@{ id = "c0"; state = "running" }) }
function Get-TailnetAddress { return $null }
function Set-SyncthingFirewallRule($Node, $Ports) { }
function Remove-NetFirewallRule { }
function Remove-SyncthingFirewallRules { }

# Only this test's own VHDX volumes: anything else would be a real node on the host's drives.
function Get-VolumeRoots { return @(Get-VhdxVolumeRoots $testVhdxPaths) }

function Test-Expectation([string]$What, $Expected, $Actual) {
    if ("$Expected" -eq "$Actual") { Write-Host "  PASS $What`: $Actual" -ForegroundColor Green; $script:passed++ }
    else { Write-Host "  FAIL $What`: expected '$Expected', got '$Actual'" -ForegroundColor Red; $script:failed++ }
}

function Read-TestHeartbeat { return Read-JsonFile (Join-Path $stackFolder "host-agent\status\heartbeat.json") }

function Get-Node([string]$Id) { return @((Read-TestHeartbeat).nodes | Where-Object { $_.id -eq $Id })[0] }

function Invoke-Api($Published, [string]$Method, [string]$Path, $Body = $null) {
    $arguments = @{ Method = $Method; Uri = "http://127.0.0.1:$($Published.syncthing.guiPort)$Path"; Headers = @{ "X-API-Key" = $Published.syncthing.apiKey }; TimeoutSec = 10; UseBasicParsing = $true }
    if ($null -ne $Body) { $arguments.ContentType = "application/json"; $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 8 -Compress }
    return Invoke-RestMethod @arguments
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) { try { if (& $Condition) { return $true } } catch { }; Start-Sleep -Seconds 1 }
    return $false
}

function Invoke-RoundsUntil([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) { Invoke-AgentRound $null $true; if (& $Condition) { return $true }; Start-Sleep -Seconds 2 }
    return $false
}

function Add-Peer($Published, [string]$DeviceId, [string]$Name, [int]$Port) {
    Invoke-Api $Published "Put" "/rest/config/devices/$DeviceId" ([pscustomobject]@{ deviceID = $DeviceId; name = $Name; addresses = @("tcp://127.0.0.1:$Port") }) | Out-Null
}

function Add-Folder($Published, [string]$Id, [string]$Path, [string[]]$Devices) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
    Invoke-Api $Published "Put" "/rest/config/folders/$Id" ([pscustomobject]@{ id = $Id; label = $Id; path = $Path; type = "sendreceive"; devices = @($Devices | ForEach-Object { [pscustomobject]@{ deviceID = $_ } }); rescanIntervalS = 3600; fsWatcherEnabled = $false }) | Out-Null
}

try {
    New-Item -ItemType Directory -Force -Path $stackFolder | Out-Null
    Set-Content -Path (Join-Path $stackFolder "docker-compose.yml") -Value "name: storage-compose"
    Write-Host "Making the test volumes..." -ForegroundColor Cyan
    $stickRoot = New-TestVolume $stickVhdx "seedstick"
    Write-TestNodeFile $stickRoot "5a1c" "seed-stick" "drive"
    $hostRoot = New-TestVolume $hostVhdx "seedhost"
    Write-TestNodeFile $hostRoot "d1e2" "seed-host" "drive"
    $keeperRoot = New-TestVolume $keeperVhdx "seedkeeper"
    Write-TestNodeFile $keeperRoot "abcd" "seed-keeper" "drive"

    Assert-VhdxVolumeRoots (Get-VolumeRoots) $testVhdxPaths 3

    $config = [pscustomobject]@{
        stackFolder = $stackFolder; projectName = "storage-agent-test"; userSid = "S-1-5-21-0"; passThrough = "none"
        syncthingPath = $SyncthingPath; syncthingSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $SyncthingPath).Hash.ToLower()
    }
    Initialize-Agent $config

    Write-Host "The agent runs both volumes' Syncthings, with no tailnet:" -ForegroundColor Cyan
    Invoke-RoundsUntil { @((Read-TestHeartbeat).nodes | Where-Object { $_.syncthing.state -eq "running" }).Count -eq 3 } 120 | Out-Null
    $stick = Get-Node "5a1c"
    $hostNode = Get-Node "d1e2"
    Test-Expectation "the three nodes run" 3 @((Read-TestHeartbeat).nodes | Where-Object { $_.syncthing.state -eq "running" }).Count
    $stickId = (Invoke-Api $stick "Get" "/rest/system/status").myID
    $hostId = (Invoke-Api $hostNode "Get" "/rest/system/status").myID

    Write-Host "A stick node seeds the host node over this device:" -ForegroundColor Cyan
    Add-Peer $stick $hostId "seed-host" $hostNode.syncthing.listenPort
    Add-Peer $hostNode $stickId "seed-stick" $stick.syncthing.listenPort
    Add-Folder $stick "work" (Join-Path $stickRoot "Work") @($stickId, $hostId)
    Add-Folder $hostNode "work" (Join-Path $hostRoot "Work") @($hostId, $stickId)
    [System.IO.File]::WriteAllText((Join-Path $stickRoot "Work\essential.txt"), "from the stick")
    Invoke-Api $stick "Post" "/rest/db/scan?folder=work" | Out-Null
    $seeded = Wait-Until { Test-Path -LiteralPath (Join-Path $hostRoot "Work\essential.txt") } 60
    Test-Expectation "the stick seeded the host node" $true $seeded
    Test-Expectation "with its content" "from the stick" $(if ($seeded) { [System.IO.File]::ReadAllText((Join-Path $hostRoot "Work\essential.txt")) } else { "" })
    Test-Expectation "nothing of the archive is on the stick" $false (Test-Path -LiteralPath (Join-Path $stickRoot "Archive"))

    Write-Host "The rest arrives once a keeper is reachable:" -ForegroundColor Cyan
    $keeper = Get-Node "abcd"
    $keeperId = (Invoke-Api $keeper "Get" "/rest/system/status").myID
    Add-Peer $keeper $hostId "seed-host" $hostNode.syncthing.listenPort
    Add-Peer $hostNode $keeperId "keeper" $keeper.syncthing.listenPort
    Add-Folder $keeper "archive" (Join-Path $keeperRoot "Archive") @($keeperId, $hostId)
    Add-Folder $hostNode "archive" (Join-Path $hostRoot "Archive") @($hostId, $keeperId)
    [System.IO.File]::WriteAllText((Join-Path $keeperRoot "Archive\old.mkv"), "the keeper's copy")
    Invoke-Api $keeper "Post" "/rest/db/scan?folder=archive" | Out-Null
    $arrived = Wait-Until { Test-Path -LiteralPath (Join-Path $hostRoot "Archive\old.mkv") } 60
    Test-Expectation "the rest arrived from the keeper" $true $arrived
    Test-Expectation "with its content" "the keeper's copy" $(if ($arrived) { [System.IO.File]::ReadAllText((Join-Path $hostRoot "Archive\old.mkv")) } else { "" })
} catch {
    Write-Host "  FAIL the run stopped: $_" -ForegroundColor Red
    $script:failed++
} finally {
    Stop-AllNodeInstances "test cleanup"
    Remove-TestVolume $stickVhdx
    Remove-TestVolume $hostVhdx
    Remove-TestVolume $keeperVhdx
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}
Write-Host ""
Write-Host "VHDX seed: $script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
