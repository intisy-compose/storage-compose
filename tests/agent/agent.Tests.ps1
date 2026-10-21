# Pester 3.4: the agent's rounds and lifetime against fakes for Docker, the clock, the volumes, the
# pass-through and the native Syncthings. Nothing here reaches Docker, WSL, a disk or the service
# manager; the first test proves the shadowing holds.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-rounds-$([guid]::NewGuid())"
$stackFolder = Join-Path $scratch "storage-compose"

function Get-StackContainerStates { $global:dockerCalls++; return $global:containerStates }
function Get-Now { return $global:now }
function Get-VolumeRoots { return @("F:\") }
function Find-Nodes([string[]]$VolumeRoots) { $global:scans++; return [pscustomobject]@{ nodes = @($global:nodes); problems = @() } }
function Update-NodeInstances([object[]]$Nodes, [bool]$IsActive) { $global:nodeRounds += , @{ active = $IsActive; nodes = @($Nodes) }; return $null }
function Invoke-WatcherRound($State, [bool]$StackIsRunning = $true) { $global:passRounds += $StackIsRunning }
function Stop-AllNodeInstances([string]$Reason) { $global:actions += "stop syncthings" }
function Remove-SyncthingFirewallRules { $global:actions += "remove firewall rules" }
function Remove-AllDisks($State) { $global:actions += "release disks" }
function Remove-AgentService { $global:actions += "remove service" }
function Register-VolumeEvents { return $false }
function Open-StopSignal([string]$Name) { return $null }
function Wait-ForNextRound($StopHandle, [bool]$HasVolumeEvents) {
    $global:now = $global:now.AddSeconds(5)
    $global:waits++
    return [pscustomobject]@{ volumeChanged = $false; stopRequested = ($global:stopAfterWaits -and $global:waits -ge $global:stopAfterWaits) }
}

$start = [datetime]"2026-10-20T12:00:00"

function Reset-World([object[]]$States) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
    New-Item -ItemType Directory -Force -Path $stackFolder | Out-Null
    Set-Content -Path (Join-Path $stackFolder "docker-compose.yml") -Value "name: storage-compose"
    $global:containerStates = $States
    $global:now = $start
    $global:dockerCalls = 0
    $global:scans = 0
    $global:nodes = @([pscustomobject]@{ id = "b7c2"; name = "pc"; kind = "drive"; threshold = 0; assigned = @(); root = "F:\" })
    $global:nodeRounds = @()
    $global:passRounds = @()
    $global:actions = @()
    $global:waits = 0
    $global:stopAfterWaits = 0
    $script:stackGoneSince = $null
    $script:requestFirstSeen = @{}
    $script:lastNodeScan = [datetime]::MinValue
    $script:stackGraceSeconds = 600
    $config = [pscustomobject]@{
        stackFolder = $stackFolder; projectName = "storage-compose"; userSid = "S-1-5-21-1"; passThrough = "wsl"
        syncthingPath = "C:\none\syncthing.exe"; syncthingSha256 = "00"
    }
    $script:testConfigFile = Join-Path $scratch "agent-config.json"
    Write-JsonFile $script:testConfigFile $config
    Initialize-Agent $config
}

function Send-Request([bool]$Active) {
    Write-JsonFile (Join-Path $stackFolder "attach-request.json") ([pscustomobject]@{ id = [guid]::NewGuid().ToString(); active = $Active; attach = @(); release = @() })
}

function Get-LastNodeRound { return $global:nodeRounds[-1] }

function Read-Heartbeat { return Read-JsonFile (Join-Path $stackFolder "host-agent\status\heartbeat.json") }

Describe "the fakes" {
    It "shadow every command that could reach Docker, the disks or the service manager" {
        Reset-World @("running")
        Invoke-AgentRound $null $true
        $global:dockerCalls | Should Be 1
        $global:nodeRounds.Count | Should Be 1
    }
}

Describe "acting only while the stack runs" {
    It "runs the nodes while a container of the project runs" {
        Reset-World @("running", "exited")
        Invoke-AgentRound $null $true
        (Get-LastNodeRound).active | Should Be $true
        @((Get-LastNodeRound).nodes).Count | Should Be 1
    }

    It "holds nothing while every container has exited" {
        Reset-World @("exited", "exited")
        Invoke-AgentRound $null $true
        (Get-LastNodeRound).active | Should Be $false
    }

    It "holds nothing while Docker does not answer" {
        Reset-World $null
        Invoke-AgentRound $null $true
        (Get-LastNodeRound).active | Should Be $false
        (Read-Heartbeat).stack.dockerReachable | Should Be $false
    }

    It "counts a fresh active request as the stack starting, for ten minutes" {
        Reset-World @("created")
        Send-Request $true
        Invoke-AgentRound $null $true
        (Get-LastNodeRound).active | Should Be $true
        $global:now = $start.AddSeconds(599)
        Invoke-AgentRound $null $false
        (Get-LastNodeRound).active | Should Be $true
        $global:now = $start.AddSeconds(600)
        Invoke-AgentRound $null $false
        (Get-LastNodeRound).active | Should Be $false
    }

    It "does not count an inactive request" {
        Reset-World @()
        Send-Request $false
        Invoke-AgentRound $null $true
        (Get-LastNodeRound).active | Should Be $false
    }

    It "passes the drives through only while the stack runs" {
        Reset-World @("running")
        $passState = New-WatcherState $null
        Invoke-AgentRound $passState $true
        $global:containerStates = @("exited")
        Invoke-AgentRound $passState $false
        ($global:passRounds -join ",") | Should Be "True,False"
    }

    It "treats a deleted stack folder as no stack and writes nothing into it" {
        Reset-World @("running")
        Remove-Item -Recurse -Force $stackFolder
        Invoke-AgentRound $null $true
        (Get-LastNodeRound).active | Should Be $false
        Test-Path $stackFolder | Should Be $false
    }
}

Describe "finding nodes" {
    It "scans on a volume event and otherwise once a minute" {
        Reset-World @("running")
        Invoke-AgentRound $null $false
        $global:now = $start.AddSeconds(30)
        Invoke-AgentRound $null $false
        $global:scans | Should Be 1
        Invoke-AgentRound $null $true
        $global:scans | Should Be 2
        $global:now = $start.AddSeconds(91)
        Invoke-AgentRound $null $false
        $global:scans | Should Be 3
    }
}

Describe "the heartbeat" {
    It "is written every round with what the dashboard reads" {
        Reset-World @("running")
        Invoke-AgentRound (New-WatcherState $null) $true
        $heartbeat = Read-Heartbeat
        $heartbeat.schema | Should Be 1
        $heartbeat.state | Should Be "running"
        $heartbeat.os | Should Be "windows"
        $heartbeat.heartbeatEpoch | Should Be ([DateTimeOffset]$start).ToUnixTimeSeconds()
        $heartbeat.stack.active | Should Be $true
        $heartbeat.stack.runningContainers | Should Be 1
        $heartbeat.passThrough.mode | Should Be "wsl"
        $heartbeat.foundNodes[0].id | Should Be "b7c2"
    }

    It "says when the agent will remove itself" {
        Reset-World @("exited")
        Invoke-AgentRound $null $true
        [datetime](Read-Heartbeat).stack.removesItselfAt | Should Be $start.AddSeconds(600)
    }
}

Describe "removing itself" {
    It "waits the full grace period after the stack is gone" {
        Reset-World @("exited")
        Invoke-AgentRound $null $true
        $global:now = $start.AddSeconds(599)
        Invoke-AgentRound $null $false
        Test-GraceIsOver | Should Be $false
        $global:now = $start.AddSeconds(600)
        Invoke-AgentRound $null $false
        Test-GraceIsOver | Should Be $true
    }

    It "starts the clock again when the stack comes back within the grace period" {
        Reset-World @("exited")
        Invoke-AgentRound $null $true
        $global:now = $start.AddSeconds(500)
        $global:containerStates = @("running")
        Invoke-AgentRound $null $false
        $global:containerStates = @("exited")
        $global:now = $start.AddSeconds(1000)
        Invoke-AgentRound $null $false
        Test-GraceIsOver | Should Be $false
    }

    It "stops its Syncthings, closes its ports, releases the drives and unregisters, then exits with 3" {
        Reset-World @("exited")
        $ConfigFile = $script:testConfigFile
        Start-Agent | Out-Null
        $script:agentExitCode | Should Be 3
        $global:actions | Should Be @("stop syncthings", "remove firewall rules", "release disks", "remove service")
        (Read-Heartbeat).state | Should Be "removed"
        $global:now | Should Be $start.AddSeconds(600)
    }

    It "never removes itself while the stack runs" {
        Reset-World @("running")
        $global:stopAfterWaits = 200
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        $script:agentExitCode | Should Be 0
        $global:actions | Should Be @("stop syncthings")
        (Read-Heartbeat).state | Should Be "stopped"
    }
}

Describe "wsl.exe under the service" {
    It "runs as the user through the service's relay, with UTF-8 output" {
        $script:userRelay = "C:\relay\storage-compose-agent.exe"
        $script:userSid = "S-1-5-21-1"
        Mock Invoke-NativeCommand { return [pscustomobject]@{ Output = "$FilePath $($Arguments -join ' ')"; ExitCode = 0 } }
        (Invoke-Wsl @("--list", "--running")).Output | Should Be "C:\relay\storage-compose-agent.exe run-as-user S-1-5-21-1 120 --env WSL_UTF8=1 -- wsl.exe --list --running"
        $script:userRelay = $null
    }
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
