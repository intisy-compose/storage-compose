# Pester 3.4: the agent's rounds and lifetime against fakes for Docker, the clock, the volumes, the
# pass-through and the native Syncthings. Nothing here reaches Docker, WSL, a disk, the service
# manager or the live agent's mutex; the first test proves the shadowing holds.

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
function Update-DockerBackendRules([bool]$IsActive) { $global:backendBlockRounds += $IsActive }
function Remove-AllDisks($State) { $global:actions += "release disks" }
function Remove-AgentService { $global:actions += "remove service" }
function Register-VolumeEvents { return $false }
function Open-StopSignal([string]$Name) { return $null }
<#
.NOTES
The installed agent holds Global\storage-compose-agent while it runs on this host, so the real check
would end every Start-Agent here at once.
#>
function Enter-AgentInstance { return $true }
function Get-HostNetworks { return @() }
function Get-DashboardEntryText([string]$Dashboard, [string]$NodeId) {
    $global:fetches += "$Dashboard $NodeId"
    if ($null -eq $global:entryText) { throw "no answer within 10 s" }
    return $global:entryText
}
function Get-SyncthingDeviceId($Node) { return "PBMD2SH-RS3UNJU-L77BP7K-X7VFKHE-73FF74D-RRCUVRY-XNUNII3-WWU53Q6" }
function Stop-NodeSyncthing($Instance, [string]$Reason) { $global:actions += "restart $($Instance.nodeId)"; $Instance.state = "stopped" }
$agentServiceName = "storage-compose-agent-test-never-installed"
$agentFirewallGroup = "storage-compose test group"
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
    $global:backendBlockRounds = @()
    $global:actions = @()
    $global:waits = 0
    $global:stopAfterWaits = 0
    $script:stackGoneSince = $null
    $script:requestFirstSeen = @{}
    $script:lastNodeScan = [datetime]::MinValue
    $script:stackGraceSeconds = 600
    $script:syncthingInstances = @{}
    $config = [pscustomobject]@{
        stackFolder = $stackFolder; projectName = "storage-compose"; userSid = "S-1-5-21-1"; passThrough = "wsl"
        syncthingPath = "C:\none\syncthing.exe"; syncthingSha256 = "00"
    }
    $script:testConfigFile = Join-Path $scratch "agent-config.json"
    Write-JsonFile $script:testConfigFile $config
    Initialize-Agent $config
}

function Write-TestNodeFile([string]$Root, [string]$Id) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root ".storage") | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Root ".storage\node.toml"), "[node]`nid = `"$Id`"`nname = `"laptop-$Id`"`nkind = `"drive`"`nthreshold = 50`nassigned = []`n")
}

function Get-JoinedRoot([string]$Id) { return Join-Path $scratch "joined-$Id" }

function Reset-JoinedWorld([string[]]$Ids) {
    Reset-World @("running")
    $entries = @(foreach ($id in $Ids) {
        Write-TestNodeFile (Get-JoinedRoot $id) $id
        [pscustomobject][ordered]@{ root = (Get-JoinedRoot $id); dashboard = "https://storage.tail-test.ts.net" }
    })
    $config = [pscustomobject]@{
        stackFolder = $stackFolder; projectName = ""; userSid = "S-1-5-21-1"; passThrough = "none"
        syncthingPath = "C:\none\syncthing.exe"; syncthingSha256 = "00"; joinedNodes = $entries
    }
    Write-JsonFile $script:testConfigFile $config
    Initialize-Agent (Read-AgentConfig $script:testConfigFile)
    $script:hasJoinedNodes = $true
    $script:lastJoinedFetch = [datetime]::MinValue
    $script:joinedDeviceIds = @{}
    $script:joinedFetchProblems = @{}
    $global:entryText = $null
    $global:fetches = @()
}

function Read-JoinedEntries { return Read-JsonFile (Join-Path $stackFolder "host-agent\connections\joined.json") }

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
        $global:backendBlockRounds.Count | Should Be 1
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

    It "carries the node volume's size and free space" {
        Reset-World @("running")
        $script:syncthingInstances = @{ b7c2 = [pscustomobject]@{ node = $global:nodes[0]; state = "running"; processId = 1; deviceId = "D"; startedAt = $null; listenAddress = $null; apiKey = "k"; problem = $null; ports = $null } }
        $global:nodes[0].root = $scratch
        Invoke-AgentRound $null $true
        $space = (Read-Heartbeat).nodes[0].space
        $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($scratch))
        $space.size | Should Be $drive.TotalSize
        ($space.free -gt 0 -and $space.free -le $space.size) | Should Be $true
        $script:syncthingInstances = @{}
    }

    It "carries no space for a root that is not on a readable volume" {
        (Get-NodeSpace "") | Should BeNullOrEmpty
    }

    It "logs a failure to read the host's networks once, and once more when they can be read again" {
        Reset-World @("running")
        $script:networksProblem = ""
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        Mock Get-HostNetworks { throw "no WMI" }
        foreach ($round in 1..3) { @(Get-HeartbeatNetworks).Count | Should Be 0 }
        Mock Get-HostNetworks { return @([pscustomobject]@{ kind = "tailnet"; address = "100.75.76.90" }) }
        foreach ($round in 1..2) { @(Get-HeartbeatNetworks).Count | Should Be 1 }
        $global:logged | Should Be @("could not read the host's networks: no WMI", "the host's networks can be read again")
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

Describe "choosing the mode" {
    It "is stack mode whenever the config names the stack project" {
        Get-AgentMode ([pscustomobject]@{ projectName = "storage-compose"; joinedNodes = @([pscustomobject]@{ root = "F:\" }) }) | Should Be "stack"
    }

    It "is joined mode for a config without one" {
        Get-AgentMode ([pscustomobject]@{ projectName = "" }) | Should Be "joined"
    }
}

Describe "joined mode" {
    It "runs its joined nodes without asking Docker, passing drives through or keeping the Docker rules" {
        Reset-JoinedWorld @("a001")
        Invoke-AgentRound (New-WatcherState $null) $true
        $global:dockerCalls | Should Be 0
        @($global:passRounds).Count | Should Be 0
        @($global:backendBlockRounds).Count | Should Be 0
        (Get-LastNodeRound).active | Should Be $true
        @((Get-LastNodeRound).nodes | ForEach-Object { $_.id }) | Should Be @("a001")
        $heartbeat = Read-Heartbeat
        $heartbeat.mode | Should Be "joined"
        $heartbeat.stack.active | Should Be $true
        $heartbeat.passThrough.mode | Should Be "none"
    }

    It "runs only the nodes its joins named, never scanning the volumes" {
        Reset-JoinedWorld @("a001")
        Invoke-AgentRound $null $true
        $global:scans | Should Be 0
        @((Get-LastNodeRound).nodes | ForEach-Object { $_.id }) -contains "b7c2" | Should Be $false
    }

    It "stops a node whose file is gone and keeps running the others" {
        Reset-JoinedWorld @("a001", "a002")
        Invoke-AgentRound $null $true
        Remove-Item -Force (Join-Path (Get-JoinedRoot "a001") ".storage\node.toml")
        Invoke-AgentRound $null $false
        @((Get-LastNodeRound).nodes | ForEach-Object { $_.id }) | Should Be @("a002")
        Test-AgentShouldRemoveItself | Should Be $false
    }

    It "keeps a node file it cannot read as a joined node" {
        Reset-JoinedWorld @("a001")
        [System.IO.File]::WriteAllText((Join-Path (Get-JoinedRoot "a001") ".storage\node.toml"), "[node]`nid = ")
        Invoke-AgentRound $null $true
        @((Get-LastNodeRound).nodes).Count | Should Be 0
        Test-AgentShouldRemoveItself | Should Be $false
        @((Read-Heartbeat).problems).Count | Should Be 1
    }

    It "removes itself at once, with no grace period, once no joined node file is left" {
        Reset-JoinedWorld @("a001")
        Remove-Item -Force (Join-Path (Get-JoinedRoot "a001") ".storage\node.toml")
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        $script:agentExitCode | Should Be 3
        $global:actions | Should Be @("stop syncthings", "remove firewall rules", "remove service")
        $global:now | Should Be $start
        $global:dockerCalls | Should Be 0
        (Read-Heartbeat).state | Should Be "removed"
    }

    It "never removes itself while a joined node file exists" {
        Reset-JoinedWorld @("a001")
        $global:stopAfterWaits = 150
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        $script:agentExitCode | Should Be 0
        $global:actions | Should Be @("stop syncthings")
        (Read-Heartbeat).state | Should Be "stopped"
    }
}

Describe "joined mode's connections entries" {
    $profileEntry = '{"options": {"natEnabled": true, "localAnnounceEnabled": true}, "listenAddresses": ["tcp://0.0.0.0:22000", "quic://0.0.0.0:22000"]}'

    It "fetches each node's entry from its dashboard under the joined id and keeps it on the node's own port" {
        Reset-JoinedWorld @("a001")
        $global:entryText = $profileEntry
        Invoke-AgentRound $null $true
        $global:fetches | Should Be @("https://storage.tail-test.ts.net device-pbmd2sh")
        ((Read-JoinedEntries).a001.listenAddresses -join ",") | Should Be "tcp://0.0.0.0:22001,quic://0.0.0.0:22001"
        (Get-NodeConnections ([pscustomobject]@{ id = "a001" })).options.natEnabled | Should Be $true
    }

    It "leaves the stack's connections.json alone" {
        Reset-JoinedWorld @("a001")
        $global:entryText = $profileEntry
        Invoke-AgentRound $null $true
        Test-Path (Join-Path $stackFolder "host-agent\connections\connections.json") | Should Be $false
    }

    It "asks once a minute" {
        Reset-JoinedWorld @("a001")
        $global:entryText = $profileEntry
        Invoke-AgentRound $null $true
        $global:now = $start.AddSeconds(55)
        Invoke-AgentRound $null $false
        @($global:fetches).Count | Should Be 1
        $global:now = $start.AddSeconds(60)
        Invoke-AgentRound $null $false
        @($global:fetches).Count | Should Be 2
    }

    It "keeps the last copy while the dashboard does not answer, and logs that once" {
        Reset-JoinedWorld @("a001")
        $global:entryText = $profileEntry
        Invoke-AgentRound $null $true
        $global:entryText = $null
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        foreach ($minute in 1..3) {
            $global:now = $start.AddMinutes($minute)
            Invoke-AgentRound $null $false
        }
        ((Read-JoinedEntries).a001.listenAddresses -join ",") | Should Be "tcp://0.0.0.0:22001,quic://0.0.0.0:22001"
        @($global:logged | Where-Object { $_ -like "*no entry from*" }).Count | Should Be 1
    }

    It "restarts a running node's Syncthing when its entry changed, and only then" {
        Reset-JoinedWorld @("a001")
        $instance = New-SyncthingInstance (Read-NodeFile (Get-JoinedRoot "a001"))
        $instance.state = "running"
        $instance.attempts = @((Get-Date), (Get-Date))
        $script:syncthingInstances = @{ a001 = $instance }
        $global:entryText = $profileEntry
        Invoke-AgentRound $null $true
        $global:actions | Should Be @("restart a001")
        @($instance.attempts).Count | Should Be 0
        $instance.state = "running"
        $global:now = $start.AddMinutes(1)
        Invoke-AgentRound $null $false
        $global:actions | Should Be @("restart a001")
        $global:entryText = '{"options": {"natEnabled": false, "localAnnounceEnabled": false}, "listenAddresses": ["tcp://0.0.0.0:22000"]}'
        $global:now = $start.AddMinutes(2)
        Invoke-AgentRound $null $false
        $global:actions | Should Be @("restart a001", "restart a001")
        $script:syncthingInstances = @{}
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
