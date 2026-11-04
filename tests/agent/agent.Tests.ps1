# Pester 3.4: the agent's rounds and lifetime against fakes for Docker, the clock, the volumes, the
# pass-through and the native Syncthings. Nothing here reaches Docker, WSL, a disk, the service
# manager or the live agent's mutex; the first test proves the shadowing holds.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-rounds-$([guid]::NewGuid())"
$stackFolder = Join-Path $scratch "storage-compose"

$realGetStackLastFinishedAt = (Get-Item function:\Get-StackLastFinishedAt).ScriptBlock
$realGetStackContainers = (Get-Item function:\Get-StackContainers).ScriptBlock
$realGetDockerSystemTime = (Get-Item function:\Get-DockerSystemTime).ScriptBlock
$realInvokeWatcherRound = (Get-Item function:\Invoke-WatcherRound).ScriptBlock
function Get-StackContainers {
    $global:dockerCalls++
    if ($null -eq $global:containerStates) { return $null }
    $index = 0
    return ,@($global:containerStates | ForEach-Object { [pscustomobject]@{ id = "$($global:containerIdPrefix)$index"; state = $_ }; $index++ })
}
function Test-DockerIsInstalled { return -not $global:dockerIsMissing }
function Get-DockerSystemTime {
    $global:systemTimeCalls++
    return $global:now.AddSeconds($global:vmClockOffsetSeconds)
}
function Get-StackLastFinishedAt([string[]]$Ids) {
    $global:finishedAtCalls++
    if ($global:finishedAtThrows) { throw "docker inspect did not answer" }
    return $global:lastFinishedAt
}
function Get-Now { return $global:now }
function Get-VolumeRoots { return @("F:\") }
function Find-Nodes([string[]]$VolumeRoots) { $global:scans++; return [pscustomobject]@{ nodes = @($global:nodes); problems = @() } }
function Update-NodeInstances([object[]]$Nodes, [bool]$IsActive) { $global:nodeRounds += , @{ active = $IsActive; nodes = @($Nodes) }; $global:sequence += "nodes"; return $global:binaryProblemToReport }
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
function Get-DashboardEntryText([string]$Dashboard, [string]$NodeId, [double]$TimeoutSeconds) {
    $global:fetches += "$Dashboard $NodeId"
    $global:fetchTimeouts += $TimeoutSeconds
    $global:sequence += "fetch"
    if ($global:fetchDelayMilliseconds) { Start-Sleep -Milliseconds $global:fetchDelayMilliseconds }
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
    if ($global:onWait) { & $global:onWait }
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
    $global:onWait = $null
    $global:lastFinishedAt = $null
    $global:finishedAtThrows = $false
    $global:containerIdPrefix = "c"
    $global:dockerIsMissing = $false
    $global:vmClockOffsetSeconds = 0
    $global:systemTimeCalls = 0
    $script:lastDockerClockRead = [datetime]::MinValue
    $script:dockerClockOffsetSeconds = $null
    $script:stoppedWithDockerKey = $null
    $global:finishedAtCalls = 0
    $script:dockerWaitReason = ""
    $script:stackGoneSince = $null
    $script:requestFirstSeen = @{}
    $script:lastNodeScan = [datetime]::MinValue
    $script:stackGraceSeconds = 600
    $script:syncthingInstances = @{}
    $script:lastJoinedNodes = @{}
    $script:joinedNodeProblems = @{}
    $script:binaryProblem = ""
    $script:joinedFetchBudgetSeconds = 10
    $global:binaryProblemToReport = $null
    $global:sequence = @()
    $global:fetchTimeouts = @()
    $global:fetchDelayMilliseconds = 0
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

function New-JoinedEntry([string]$Root) { return [pscustomobject][ordered]@{ root = $Root; dashboard = "https://storage.tail-test.ts.net" } }

function Get-AbsentVolumeRoot {
    $letter = [char[]](68..90) | Where-Object { -not [System.IO.Directory]::Exists("$($_):\") } | Select-Object -Last 1
    return "$($letter):\"
}

function Write-JoinedConfig([object[]]$Entries) {
    $config = [pscustomobject]@{
        stackFolder = $stackFolder; projectName = ""; userSid = "S-1-5-21-1"; passThrough = "none"
        syncthingPath = "C:\none\syncthing.exe"; syncthingSha256 = "00"; joinedNodes = @($Entries)
    }
    Write-JsonFile $script:testConfigFile $config
    Initialize-Agent (Read-AgentConfig $script:testConfigFile)
}

function Reset-JoinedWorld([string[]]$Ids, [string[]]$ExtraRoots = @()) {
    Reset-World @("running")
    $entries = @(foreach ($id in $Ids) {
        Write-TestNodeFile (Get-JoinedRoot $id) $id
        New-JoinedEntry (Get-JoinedRoot $id)
    }) + @($ExtraRoots | ForEach-Object { New-JoinedEntry $_ })
    Write-JoinedConfig $entries
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

Describe "joined nodes whose file cannot be read" {
    It "keeps a node whose volume is away at the first round, runs nothing for it and stays" {
        Reset-JoinedWorld @() @(Get-AbsentVolumeRoot)
        $global:stopAfterWaits = 3
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        $script:agentExitCode | Should Be 0
        @((Get-LastNodeRound).nodes).Count | Should Be 0
        $global:actions | Should Be @("stop syncthings")
        ((Read-Heartbeat).problems -join " ") | Should Match "cannot be seen"
    }

    It "keeps a locked node file's Syncthing running as last read" {
        Reset-JoinedWorld @("a001")
        Invoke-AgentRound $null $true
        $lock = [System.IO.File]::Open((Join-Path (Get-JoinedRoot "a001") ".storage\node.toml"), "Open", "ReadWrite", "None")
        try { Invoke-AgentRound $null $false } finally { $lock.Dispose() }
        @((Get-LastNodeRound).nodes | ForEach-Object { $_.id }) | Should Be @("a001")
        Test-AgentShouldRemoveItself | Should Be $false
    }

    It "keeps a node file that no longer parses running as last read, and logs that once" {
        Reset-JoinedWorld @("a001")
        Invoke-AgentRound $null $true
        [System.IO.File]::WriteAllText((Join-Path (Get-JoinedRoot "a001") ".storage\node.toml"), "[node]`nid = ")
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        foreach ($round in 1..3) { Invoke-AgentRound $null $false }
        @((Get-LastNodeRound).nodes | ForEach-Object { $_.id }) | Should Be @("a001")
        @($global:logged | Where-Object { $_ -like "*kept running as last read*" }).Count | Should Be 1
    }

    It "keeps a node whose folder is missing on a volume that is there, and names the way out once" {
        Reset-JoinedWorld @("a001")
        Invoke-AgentRound $null $true
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        Remove-Item -Recurse -Force (Get-JoinedRoot "a001")
        foreach ($round in 1..3) { Invoke-AgentRound $null $false }
        Test-AgentShouldRemoveItself | Should Be $false
        @((Get-LastNodeRound).nodes).Count | Should Be 0
        @($global:logged | Where-Object { $_ -like "*until storage-join.ps1 -Leave or the folder returns*" }).Count | Should Be 1
    }

    It "drops a node whose file was deleted, while its volume and folder are there" {
        Reset-JoinedWorld @("a001", "a002")
        Invoke-AgentRound $null $true
        Remove-Item -Force (Join-Path (Get-JoinedRoot "a002") ".storage\node.toml")
        Invoke-AgentRound $null $false
        @((Get-LastNodeRound).nodes | ForEach-Object { $_.id }) | Should Be @("a001")
    }
}

Describe "joined mode's rounds" {
    It "starts the nodes on the kept entries before it asks the dashboard" {
        Reset-JoinedWorld @("a001")
        $global:entryText = '{"options": {}}'
        Invoke-AgentRound $null $true
        $global:sequence | Should Be @("nodes", "fetch")
    }

    It "spends at most the round's budget on fetching, whatever the number of nodes" {
        Reset-JoinedWorld @("a001", "a002", "a003")
        $script:joinedFetchBudgetSeconds = 1
        $global:fetchDelayMilliseconds = 600
        $global:entryText = '{"options": {}}'
        Invoke-AgentRound $null $true
        @($global:fetches).Count | Should Be 2
        @($global:fetchTimeouts | Where-Object { $_ -gt 1 }).Count | Should Be 0
    }

    It "logs a missing Syncthing once and keeps it in the heartbeat" {
        Reset-JoinedWorld @("a001")
        $global:binaryProblemToReport = "Syncthing is missing at C:\gone\syncthing.exe; run up or the join again"
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        foreach ($round in 1..3) { Invoke-AgentRound $null $false }
        @($global:logged | Where-Object { $_ -like "*Syncthing is missing*" }).Count | Should Be 1
        ((Read-Heartbeat).problems -join " ") | Should Match "Syncthing is missing"
    }

    It "never restarts a node for an entry fetched again unchanged" {
        Reset-JoinedWorld @("a001")
        $instance = New-SyncthingInstance (Read-NodeFile (Get-JoinedRoot "a001"))
        $instance.state = "running"
        $global:entryText = '{"options": {"natEnabled": true, "maxSendKbps": 100, "globalAnnounceServers": ["default"]}, "listenAddresses": ["tcp://0.0.0.0:22000"], "deviceAddresses": {}}'
        Invoke-AgentRound $null $true
        $script:syncthingInstances = @{ a001 = $instance }
        foreach ($minute in 1..2) {
            $global:now = $start.AddMinutes($minute)
            Invoke-AgentRound $null $false
        }
        @($global:fetches).Count | Should Be 3
        @($global:actions | Where-Object { $_ -like "restart*" }).Count | Should Be 0
        $script:syncthingInstances = @{}
    }

    It "drops the kept entries of nodes that left" {
        Reset-JoinedWorld @("a001", "a002")
        $global:entryText = '{"options": {}}'
        Invoke-AgentRound $null $true
        @((Read-JoinedEntries).PSObject.Properties | ForEach-Object { $_.Name }) | Should Be @("a001", "a002")
        Remove-Item -Force (Join-Path (Get-JoinedRoot "a002") ".storage\node.toml")
        Invoke-AgentRound $null $false
        @((Read-JoinedEntries).PSObject.Properties | ForEach-Object { $_.Name }) | Should Be @("a001")
    }

    It "keeps every kept entry while a node's volume is away" {
        Reset-JoinedWorld @("a001", "a002")
        $global:entryText = '{"options": {}}'
        Invoke-AgentRound $null $true
        Write-JoinedConfig @((New-JoinedEntry (Get-JoinedRoot "a001")), (New-JoinedEntry (Get-AbsentVolumeRoot)))
        Invoke-AgentRound $null $false
        @((Read-JoinedEntries).PSObject.Properties | ForEach-Object { $_.Name }) | Should Be @("a001", "a002")
    }
}

Describe "waiting out Docker" {
    function Invoke-RoundAt([int]$Seconds, $States) {
        $global:now = $start.AddSeconds($Seconds)
        $global:containerStates = $States
        Invoke-AgentRound (New-WatcherState $null) $false
    }

    function Assert-StackIsHeld {
        (Get-LastNodeRound).active | Should Be $true
        $global:passRounds[-1] | Should Be $false
        $global:backendBlockRounds[-1] | Should Be $false
        $script:stackGoneSince | Should BeNullOrEmpty
        Test-GraceIsOver | Should Be $false
        (Read-Heartbeat).stack.waitingForDocker | Should Be $true
        (Read-Heartbeat).stack.removesItselfAt | Should BeNullOrEmpty
    }

    function Start-DockerOutage {
        Reset-World @("running")
        Invoke-AgentRound $null $true
        Invoke-RoundAt 5 @("exited", "exited")
        Invoke-RoundAt 10 $null
    }

    It "never counts while Docker does not answer, and keeps only the native nodes, never passing the drives through" {
        Start-DockerOutage
        Assert-StackIsHeld
        Invoke-RoundAt 1000 $null
        Assert-StackIsHeld
        (Read-Heartbeat).stack.dockerReachable | Should Be $false
    }

    It "keeps waiting once Docker answers again while the containers exited with Docker's own stop" {
        Start-DockerOutage
        $global:lastFinishedAt = $start.AddSeconds(3)
        Invoke-RoundAt 100 @("exited", "exited")
        Assert-StackIsHeld
        Invoke-RoundAt 2000 @("exited", "exited")
        Assert-StackIsHeld
        (Read-Heartbeat).stack.dockerReachable | Should Be $true
    }

    It "waits for a container that Docker's start could not bring back, finished after Docker returned" {
        Start-DockerOutage
        $global:lastFinishedAt = $start.AddSeconds(95)
        Invoke-RoundAt 100 @("exited")
        Assert-StackIsHeld
    }

    It "counts a stack stopped while Docker kept running, without asking when its containers finished" {
        Reset-World @("running")
        Invoke-AgentRound $null $true
        Invoke-RoundAt 5 @("exited")
        Invoke-RoundAt 605 @("exited")
        Test-GraceIsOver | Should Be $true
        $global:finishedAtCalls | Should Be 0
        (Read-Heartbeat).stack.waitingForDocker | Should Be $false
    }

    It "counts a stack stopped well before Docker went away, from when Docker answers again" {
        Reset-World @("running")
        Invoke-AgentRound $null $true
        Invoke-RoundAt 5 @("exited")
        Invoke-RoundAt 300 @("exited")
        Invoke-RoundAt 305 $null
        $script:stackGoneSince | Should BeNullOrEmpty
        $global:lastFinishedAt = $start.AddSeconds(4)
        Invoke-RoundAt 400 @("exited")
        (Get-LastNodeRound).active | Should Be $false
        $script:stackGoneSince | Should Be $start.AddSeconds(400)
        $script:agentState.dockerOutage | Should BeNullOrEmpty
        Invoke-RoundAt 1000 @("exited")
        Test-GraceIsOver | Should Be $true
    }

    It "counts a stack whose containers were removed while Docker ran" {
        Start-DockerOutage
        Invoke-RoundAt 100 @()
        (Get-LastNodeRound).active | Should Be $false
        Invoke-RoundAt 700 @()
        Test-GraceIsOver | Should Be $true
    }

    It "keeps waiting while Docker lists the containers but does not say when they finished" {
        Start-DockerOutage
        $global:finishedAtThrows = $true
        Invoke-RoundAt 100 @("exited")
        Assert-StackIsHeld
    }

    It "forgets the outage once the stack runs again, so a later stop counts" {
        Start-DockerOutage
        $global:lastFinishedAt = $start.AddSeconds(3)
        Invoke-RoundAt 100 @("exited")
        Invoke-RoundAt 200 @("running")
        $script:agentState.dockerOutage | Should BeNullOrEmpty
        Invoke-RoundAt 300 @("exited")
        Invoke-RoundAt 900 @("exited")
        Test-GraceIsOver | Should Be $true
    }

    It "never waits for Docker for a deleted stack folder" {
        Reset-World @("running")
        Invoke-AgentRound $null $true
        Remove-Item -Recurse -Force $stackFolder
        Invoke-RoundAt 5 $null
        (Get-LastNodeRound).active | Should Be $false
        $script:stackGoneSince | Should Be $start.AddSeconds(5)
    }

    It "keeps when Docker last answered across a restart of the agent" {
        Reset-World @("running")
        $global:stopAfterWaits = 1
        $ConfigFile = $script:testConfigFile
        Start-Agent | Out-Null
        Initialize-Agent (Read-AgentConfig $script:testConfigFile)
        Invoke-RoundAt 60 $null
        ConvertFrom-SavedTime $script:agentState.dockerOutage.lastAnsweredAt | Should Be $start
        $global:lastFinishedAt = $start.AddSeconds(-1000)
        Invoke-RoundAt 120 @("exited")
        (Get-LastNodeRound).active | Should Be $false
    }

    It "takes a stop as Docker's when it never saw Docker answer before the outage" {
        Reset-World $null
        Invoke-AgentRound $null $true
        $global:lastFinishedAt = $start.AddSeconds(-100000)
        Invoke-RoundAt 60 @("exited")
        Assert-StackIsHeld
    }

    It "logs each change once" {
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        Start-DockerOutage
        Invoke-RoundAt 15 $null
        $global:lastFinishedAt = $start.AddSeconds(3)
        Invoke-RoundAt 100 @("exited")
        Invoke-RoundAt 105 @("exited")
        Invoke-RoundAt 110 @("running")
        @($global:logged | Where-Object { $_ -match "Docker" }) | Should Be @(
            "Docker does not answer; the nodes keep running and the grace period waits for Docker",
            "the stack's containers exited with Docker's own stop; the nodes keep running until the stack runs again or is shut down",
            "no longer waiting for Docker: the stack runs")
    }

    It "stops waiting for Docker after a day, says so once, and then counts the grace" {
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        Start-DockerOutage
        Invoke-RoundAt 86409 $null
        Assert-StackIsHeld
        Invoke-RoundAt 86410 $null
        Invoke-RoundAt 86415 $null
        (Get-LastNodeRound).active | Should Be $false
        $script:stackGoneSince | Should Be $start.AddSeconds(86410)
        (Read-Heartbeat).stack.waitingForDocker | Should Be $false
        @($global:logged | Where-Object { $_ -match "^waited" }) | Should Be @("waited 86400 s for Docker; the stack counts as gone and the grace period counts")
        Invoke-RoundAt 87010 $null
        Test-GraceIsOver | Should Be $true
    }

    It "stops waiting after a day for containers that exited with Docker's stop" {
        Start-DockerOutage
        $global:lastFinishedAt = $start.AddSeconds(3)
        Invoke-RoundAt 100 @("exited")
        Assert-StackIsHeld
        Invoke-RoundAt 86410 @("exited")
        (Get-LastNodeRound).active | Should Be $false
    }

    It "bounds a wait on a docker inspect that keeps failing by the same day" {
        Start-DockerOutage
        $global:finishedAtThrows = $true
        Invoke-RoundAt 100 @("exited")
        Assert-StackIsHeld
        Invoke-RoundAt 86410 @("exited")
        (Get-LastNodeRound).active | Should Be $false
    }

    It "takes a host without a docker command as no Docker, and counts the stack as gone" {
        Reset-World @("running")
        Invoke-AgentRound $null $true
        $global:dockerIsMissing = $true
        Invoke-RoundAt 5 $null
        (Get-LastNodeRound).active | Should Be $false
        $script:stackGoneSince | Should Be $start.AddSeconds(5)
        $script:agentState.dockerOutage | Should BeNullOrEmpty
        (Read-Heartbeat).stack.waitingForDocker | Should Be $false
    }

    It "asks Docker when the containers finished once per outage while the same containers stay" {
        Start-DockerOutage
        $global:lastFinishedAt = $start.AddSeconds(3)
        foreach ($second in 100..400) { if ($second % 5 -eq 0) { Invoke-RoundAt $second @("exited", "exited") } }
        $global:finishedAtCalls | Should Be 1
        $global:containerIdPrefix = "recreated"
        Invoke-RoundAt 405 @("exited", "exited")
        $global:finishedAtCalls | Should Be 2
    }

    It "compares on the VM's clock when it runs ten minutes behind the host" {
        Reset-World @("running")
        $global:vmClockOffsetSeconds = -600
        Invoke-AgentRound $null $true
        Invoke-RoundAt 5 @("exited", "exited")
        Invoke-RoundAt 10 $null
        $global:lastFinishedAt = $start.AddSeconds(3 - 600)
        Invoke-RoundAt 100 @("exited", "exited")
        Assert-StackIsHeld
        $global:systemTimeCalls | Should Be 2
    }

    It "drops a saved outage that is not an object and a time that does not parse, and says so once" {
        $global:logged = @()
        Mock Write-WatcherLog { $global:logged += $Message }
        Reset-World @("running")
        Write-JsonFile $script:agentStateFile ([pscustomobject]@{ ports = [pscustomobject]@{}; dockerOutage = "yesterday"; dockerAnsweredAt = "not a time" })
        Initialize-Agent (Read-AgentConfig $script:testConfigFile)
        $script:agentState.dockerOutage | Should BeNullOrEmpty
        $script:agentState.dockerAnsweredAt | Should BeNullOrEmpty
        @($global:logged | Where-Object { $_ -match "unreadable" }) | Should Be @("state.json had an unreadable dockerAnsweredAt, dockerOutage; the agent starts without it")
        Write-JsonFile $script:agentStateFile ([pscustomobject]@{ dockerOutage = [pscustomobject]@{ noticedAt = "soon"; lastAnsweredAt = $null } })
        Initialize-Agent (Read-AgentConfig $script:testConfigFile)
        $script:agentState.dockerOutage | Should BeNullOrEmpty
    }

    It "takes a last answer it cannot read as Docker's stop, within the day" {
        Start-DockerOutage
        $script:agentState.dockerOutage = [pscustomobject]@{ lastAnsweredAt = "garbage"; lastAnsweredVmAt = $null; noticedAt = $start.AddSeconds(10).ToString("o") }
        $global:lastFinishedAt = $start.AddSeconds(-100000)
        Invoke-RoundAt 100 @("exited")
        Assert-StackIsHeld
    }

    It "never takes the attach path while it waits" {
        Mock Get-DockerVmBootId { return "boot-after-restart" }
        Mock Get-WindowsDisks { return @() }
        Mock Update-BlankPassedDisks { }
        Mock Remove-VanishedDisks { }
        Mock Update-SmartReports { }
        Mock Update-PublishedDisks { }
        Mock Add-RequestedDisks { $global:attachCalls++ }
        Mock Add-ArrayDisks { $global:attachCalls++ }
        Mock Invoke-WatcherRound { & $realInvokeWatcherRound $State $StackIsRunning }
        $global:attachCalls = 0
        Start-DockerOutage
        Write-JsonFile (Join-Path $stackFolder "attach-request.json") ([pscustomobject]@{ id = "up-before-the-restart"; active = $true; attach = @(); release = @() })
        $script:requestFirstSeen["up-before-the-restart"] = $start.AddSeconds(-1000)
        Invoke-RoundAt 20 $null
        $global:lastFinishedAt = $start.AddSeconds(3)
        Invoke-RoundAt 100 @("exited")
        (Get-LastNodeRound).active | Should Be $true
        $global:attachCalls | Should Be 0
        $global:actions -contains "release disks" | Should Be $true
    }
}

Describe "asking Docker" {
    It "tells a project without containers from Docker not answering" {
        $script:projectName = "storage-compose"
        Mock Invoke-NativeCommand { return [pscustomobject]@{ Output = ""; ExitCode = 0 } }
        $containers = & $realGetStackContainers
        $null -eq $containers | Should Be $false
        @($containers).Count | Should Be 0
        Mock Invoke-NativeCommand { return [pscustomobject]@{ Output = "error during connect"; ExitCode = 1 } }
        $null -eq (& $realGetStackContainers) | Should Be $true
    }

    It "lists each container's id and state" {
        $script:projectName = "storage-compose"
        Mock Invoke-NativeCommand { return [pscustomobject]@{ Output = "a1 running`nb2 exited"; ExitCode = 0 } }
        $containers = & $realGetStackContainers
        @($containers | ForEach-Object { "$($_.id)=$($_.state)" }) | Should Be @("a1=running", "b2=exited")
    }

    It "reads nanoseconds and skips a container that never finished" {
        ConvertFrom-DockerTime "2026-11-03T21:46:12.123456789Z" | Should Be ([DateTimeOffset]::Parse("2026-11-03T21:46:12.1234567Z").LocalDateTime)
        ConvertFrom-DockerTime "0001-01-01T00:00:00Z" | Should BeNullOrEmpty
    }

    It "gives the latest finish of the given containers and throws when Docker does not answer" {
        Mock Invoke-NativeCommand { return [pscustomobject]@{ Output = "2026-11-03T21:46:10Z`n0001-01-01T00:00:00Z"; ExitCode = 0 } }
        & $realGetStackLastFinishedAt @("a1", "b2") | Should Be ([DateTimeOffset]::Parse("2026-11-03T21:46:10Z").LocalDateTime)
        Mock Invoke-NativeCommand { return [pscustomobject]@{ Output = "error during connect"; ExitCode = 1 } }
        { & $realGetStackLastFinishedAt @("a1") } | Should Throw
    }

    It "reads the VM's clock from docker info" {
        Mock Invoke-NativeCommand { return [pscustomobject]@{ Output = "2026-11-04T10:00:00.123456789+00:00"; ExitCode = 0 } }
        & $realGetDockerSystemTime | Should Be ([DateTimeOffset]::Parse("2026-11-04T10:00:00.1234567+00:00").LocalDateTime)
    }
}

Describe "stack mode's end with joined nodes left" {
    function Reset-StackWithJoined([object[]]$Entries) {
        Reset-World @("exited")
        $config = [pscustomobject]@{
            stackFolder = $stackFolder; projectName = "storage-compose"; userSid = "S-1-5-21-1"; passThrough = "wsl"
            syncthingPath = "C:\none\syncthing.exe"; syncthingSha256 = "00"; graceSeconds = 30; joinedNodes = @($Entries)
        }
        Write-JsonFile $script:testConfigFile $config
        Initialize-Agent $config
        New-Item -ItemType Directory -Force -Path (Join-Path (Get-JoinedRoot "gone") ".storage") | Out-Null
    }

    It "drops what the stack added and goes on in joined mode, without unregistering" {
        Reset-StackWithJoined @((New-JoinedEntry (Get-JoinedRoot "a001")), (New-JoinedEntry (Get-JoinedRoot "gone")))
        Write-TestNodeFile (Get-JoinedRoot "a001") "a001"
        $global:stopAfterWaits = 9
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        $script:agentExitCode | Should Be 0
        $global:actions | Should Be @("stop syncthings", "release disks", "stop syncthings")
        $saved = Read-JsonFile $script:testConfigFile
        Get-AgentMode $saved | Should Be "joined"
        $saved.passThrough | Should Be "none"
        @($saved.joinedNodes | ForEach-Object { $_.root }) | Should Be @((Get-JoinedRoot "a001"))
        @((Get-LastNodeRound).nodes | ForEach-Object { $_.id }) | Should Be @("a001")
        (Read-Heartbeat).mode | Should Be "joined"
    }

    It "removes itself as before when no carried joined node file is left" {
        Reset-StackWithJoined @((New-JoinedEntry (Get-JoinedRoot "gone")))
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        $script:agentExitCode | Should Be 3
        $global:actions | Should Be @("stop syncthings", "remove firewall rules", "release disks", "remove service")
    }

    It "never hands over to joined mode while Docker does not answer" {
        Reset-StackWithJoined @((New-JoinedEntry (Get-JoinedRoot "a001")))
        Write-TestNodeFile (Get-JoinedRoot "a001") "a001"
        $global:containerStates = $null
        $global:stopAfterWaits = 40
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        $global:actions | Should Be @("stop syncthings")
        Get-AgentMode (Read-JsonFile $script:testConfigFile) | Should Be "stack"
    }

    It "hands over once Docker answers again and the stack was stopped well before it went away" {
        Reset-StackWithJoined @((New-JoinedEntry (Get-JoinedRoot "a001")))
        Write-TestNodeFile (Get-JoinedRoot "a001") "a001"
        $global:containerStates = @("running")
        $global:lastFinishedAt = $start.AddSeconds(-1000)
        $global:onWait = {
            if ($global:waits -eq 1) { $global:containerStates = $null }
            if ($global:waits -eq 10) { $global:containerStates = @("exited") }
        }
        $global:stopAfterWaits = 30
        $ConfigFile = $script:testConfigFile
        $script:agentExitCode = 0
        Start-Agent | Out-Null
        Get-AgentMode (Read-JsonFile $script:testConfigFile) | Should Be "joined"
        $global:actions[0..1] | Should Be @("stop syncthings", "release disks")
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
