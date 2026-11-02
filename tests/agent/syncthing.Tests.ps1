# Pester 3.4: the agent's native Syncthings, with the real pinned syncthing.exe on temporary folder
# nodes, as the current user. Only the firewall and the tailnet address are faked; the ports are moved
# away from the agent's own so a running stack is never disturbed.

param([string]$SyncthingPath)

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")

$syncthingGuiPortBase = 18450
$syncthingListenPortBase = 32100
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-syncthing-$([guid]::NewGuid())"
$global:firewallRules = @{}
$global:programRuleSweeps = @()
$global:tailnetAddress = $null

function Get-TailnetAddress { return $global:tailnetAddress }
function Get-NetFirewallRule([string]$Name) { return $global:firewallRules[$Name] }
function New-NetFirewallRule {
    param([string]$Name, [string]$DisplayName, [string]$Group, [string]$Direction, [string]$Action, [string]$Protocol, $LocalPort, [string]$RemoteAddress, [string]$Program, [string]$Profile)
    $global:firewallRules[$Name] = [pscustomobject]@{ Name = $Name; Group = $Group; LocalPort = $LocalPort; RemoteAddress = $RemoteAddress; Program = $Program }
}
function Remove-NetFirewallRule([string]$Name, [string]$Group) {
    if ($Name) { $global:firewallRules.Remove($Name) }
    if ($Group) { foreach ($key in @($global:firewallRules.Keys)) { if ($global:firewallRules[$key].Group -eq $Group) { $global:firewallRules.Remove($key) } } }
}
function Remove-ProgramFirewallRules([string]$Folder) { $global:programRuleSweeps += $Folder }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline = $true)]$Rule) process { [pscustomobject]@{ LocalPort = $Rule.LocalPort } } }
function Get-NetFirewallApplicationFilter { param([Parameter(ValueFromPipeline = $true)]$Rule) process { [pscustomobject]@{ Program = $Rule.Program } } }
$global:ipAddresses = @()
$global:connectionProfiles = @()
function Get-NetIPAddress { [CmdletBinding()] param([string]$AddressFamily) return $global:ipAddresses }
function Get-NetConnectionProfile { [CmdletBinding()] param() return $global:connectionProfiles }

function Reset-Agent {
    Stop-AllNodeInstances "test reset"
    $script:syncthingPath = $SyncthingPath
    $script:syncthingSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $SyncthingPath).Hash.ToLower()
    $script:agentState = New-AgentState $null
    $script:logFile = Join-Path $scratch "agent.log"
    $script:connectionsFile = Join-Path $scratch "host-agent\connections\connections.json"
    $global:firewallRules = @{}
    $global:programRuleSweeps = @()
    $global:tailnetAddress = $null
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
}

function New-TestNode([string]$Id, [string]$Name) {
    $root = Join-Path $scratch $Name
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    return [pscustomobject]@{ id = $Id; name = $Name; kind = "folder"; threshold = 80; assigned = @(); root = $root }
}

function Get-RootProcessCount {
    $processes = Get-SyncthingProcesses
    $ids = @($processes | ForEach-Object { [int]$_.ProcessId })
    return @($processes | Where-Object { [int]$_.ParentProcessId -notin $ids }).Count
}

function Invoke-Api($Instance, [string]$Path) {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$($Instance.ports.gui)$Path" -Headers @{ "X-API-Key" = $Instance.apiKey } -TimeoutSec 5 -UseBasicParsing
}

function Wait-ForApi($Instance) {
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        try { $status = Invoke-Api $Instance "/rest/system/status"; if ($status.PSObject.Properties["myID"]) { return $status } } catch { }; Start-Sleep -Milliseconds 500
    }
    $processes = @(Get-NodeSyncthingProcesses $Instance.node | ForEach-Object { "$($_.ProcessId)<-$($_.ParentProcessId)" }) -join " "
    $log = @(Get-Content -Tail 8 -ErrorAction SilentlyContinue (Join-Path (Get-SyncthingHome $Instance.node) "syncthing.log")) -join " | "
    throw "Syncthing for $($Instance.node.name) did not answer within 45 s on $($Instance.ports.gui) (pid $($Instance.processId), processes $processes): $log"
}

Describe "a node's native Syncthing" {
    Reset-Agent
    $node = New-TestNode "a001" "ventoy-files"
    $problem = Update-NodeInstances @($node) $true
    $instance = $script:syncthingInstances["a001"]

    It "starts with its home on the node" {
        $problem | Should BeNullOrEmpty
        $instance.state | Should Be "running"
        Test-Path (Join-Path $node.root ".storage\syncthing\config.xml") | Should Be $true
        (Get-CimInstance Win32_Process -Filter "ProcessId=$($instance.processId)").CommandLine | Should Match ([regex]::Escape("--home=$($node.root)\.storage\syncthing"))
    }

    It "answers on its loopback GUI port with the published API key and device ID" {
        $status = Wait-ForApi $instance
        $instance.ports.gui | Should Be 18450
        $status.myID | Should Be $instance.deviceId
    }

    It "listens on loopback without a tailnet address, with discovery, relays and NAT off" {
        $options = Invoke-Api $instance "/rest/config/options"
        @($options.listenAddresses) | Should Be @("tcp://127.0.0.1:32100")
        $options.globalAnnounceEnabled | Should Be $false
        $options.localAnnounceEnabled | Should Be $false
        $options.relaysEnabled | Should Be $false
        $options.natEnabled | Should Be $false
        $options.urAccepted | Should Be -1
    }

    It "lets the dashboard's container call it by host.docker.internal" {
        ([xml][System.IO.File]::ReadAllText((Join-Path $node.root ".storage\syncthing\config.xml"))).configuration.gui.insecureSkipHostcheck | Should Be "true"
    }

    It "names its own device after the node" {
        (Invoke-Api $instance "/rest/config/devices/$($instance.deviceId)").name | Should Be "ventoy-files"
    }

    It "opens its listen port to the tailnet range only" {
        $rule = $global:firewallRules["storage-compose syncthing a001"]
        $rule.LocalPort | Should Be 32100
        $rule.RemoteAddress | Should Be "100.64.0.0/10"
        $rule.Program | Should Be $SyncthingPath
    }

    It "names the program in a UDP block rule too, so Windows never asks to allow it" {
        $rule = $global:firewallRules["storage-compose syncthing a001 udp"]
        $rule.Program | Should Be $SyncthingPath
        $rule.Group | Should Be "storage-compose agent"
    }

    It "publishes what the dashboard needs" {
        $published = Get-PublishedInstance $instance
        $published.syncthing.guiPort | Should Be 18450
        $published.syncthing.apiKey | Should Be $instance.apiKey
        $published.syncthing.deviceId | Should Be $instance.deviceId
        $published.threshold | Should Be 80
    }

    It "is taken over, not started twice, by an agent that restarted" {
        $processId = $instance.processId
        $script:syncthingInstances = @{}
        Update-NodeInstances @($node) $true | Out-Null
        $taken = $script:syncthingInstances["a001"]
        $taken.processId | Should Be $processId
        $taken.apiKey | Should Be $instance.apiKey
        Get-RootProcessCount | Should Be 1
    }

    It "is started again after it exits, its orphaned child ended first" {
        $old = $script:syncthingInstances["a001"].processId
        Stop-Process -Id $old -Force
        Start-Sleep -Milliseconds 500
        $answered = $false
        for ($round = 0; $round -lt 12 -and -not $answered; $round++) {
            Update-NodeInstances @($node) $true | Out-Null
            $instance = $script:syncthingInstances["a001"]
            try { $answered = [bool](Invoke-Api $instance "/rest/system/status").PSObject.Properties["myID"] } catch { Start-Sleep -Seconds 5 }
        }
        $answered | Should Be $true
        $script:syncthingInstances["a001"].processId | Should Not Be $old
        Get-RootProcessCount | Should Be 1
    }

    It "moves to the tailnet address once Tailscale has one" {
        $global:tailnetAddress = "127.0.0.2"
        Update-NodeInstances @($node) $true | Out-Null
        $moved = $script:syncthingInstances["a001"]
        Wait-ForApi $moved | Out-Null
        @((Invoke-Api $moved "/rest/config/options").listenAddresses) | Should Be @("tcp://127.0.0.2:32100")
    }

    It "keeps the node's ports across restarts" {
        $second = New-TestNode "a002" "second"
        Update-NodeInstances @($node, $second) $true | Out-Null
        $script:syncthingInstances["a002"].ports.gui | Should Be 18451
        Update-NodeInstances @($second) $true | Out-Null
        Update-NodeInstances @($second, $node) $true | Out-Null
        $script:syncthingInstances["a001"].ports.gui | Should Be 18450
        $script:syncthingInstances["a002"].ports.gui | Should Be 18451
    }

    It "stops a node whose volume is gone and closes its port" {
        Update-NodeInstances @($node) $true | Out-Null
        $script:syncthingInstances.ContainsKey("a002") | Should Be $false
        $global:firewallRules.ContainsKey("storage-compose syncthing a002") | Should Be $false
        Get-RootProcessCount | Should Be 1
    }

    It "stops everything while the stack is not running" {
        Update-NodeInstances @($node) $false | Out-Null
        $script:syncthingInstances.Count | Should Be 0
        @(Get-SyncthingProcesses).Count | Should Be 0
        $global:firewallRules.Count | Should Be 0
        $global:programRuleSweeps[-1] | Should Be (Split-Path (Split-Path $SyncthingPath))
    }

    It "refuses a binary that does not match its recorded checksum" {
        $script:syncthingSha256 = "0" * 64
        $problem = Update-NodeInstances @($node) $true
        $problem | Should Match "checksum"
        @(Get-SyncthingProcesses).Count | Should Be 0
    }

    Reset-Agent
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}

function Write-ConnectionsFile($ByNode) {
    New-Item -ItemType Directory -Force -Path (Split-Path $script:connectionsFile) | Out-Null
    [System.IO.File]::WriteAllText($script:connectionsFile, (ConvertTo-Json -InputObject $ByNode -Depth 10))
}

function New-ConfiguredNode([string]$Id, [string]$Name) {
    $node = New-TestNode $Id $Name
    New-Item -ItemType Directory -Force -Path (Get-SyncthingHome $node) | Out-Null
    New-SyncthingConfig $node
    return $node
}

function Read-ConfigOptions($Node) { return ([xml][System.IO.File]::ReadAllText((Get-SyncthingConfigPath $Node))).configuration.options }

function Get-ConfiguredListenAddresses($Node) { return @((Read-ConfigOptions $Node).SelectNodes("listenAddress") | ForEach-Object { $_.InnerText }) }

Describe "the connection profile in a node's config" {
    Reset-Agent
    $ports = [pscustomobject]@{ slot = 0; gui = 18460; listen = 32110 }
    $listenAddresses = @("tcp://0.0.0.0:32110", "quic://0.0.0.0:32110", "relay://192.168.1.5:22100/?id=RELAY", "dynamic+https://relays.syncthing.net/endpoint")
    $profiled = @{
        options = [ordered]@{
            localAnnounceEnabled = $true; natEnabled = $true; globalAnnounceEnabled = $true; globalAnnounceServers = @("default")
            relaysEnabled = $true; maxSendKbps = 500; maxRecvKbps = 250; limitBandwidthInLan = $true
        }
        listenAddresses = $listenAddresses
        deviceAddresses = @{}
    }

    It "with connections.json it writes the profile's options" {
        $node = New-ConfiguredNode "c001" "profiled"
        Write-ConnectionsFile @{ c001 = $profiled }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        $options = Read-ConfigOptions $node
        $options.localAnnounceEnabled | Should Be "true"
        $options.natEnabled | Should Be "true"
        $options.globalAnnounceEnabled | Should Be "true"
        @($options.SelectNodes("globalAnnounceServer") | ForEach-Object { $_.InnerText }) | Should Be @("default")
        $options.relaysEnabled | Should Be "true"
        $options.maxSendKbps | Should Be "500"
        $options.maxRecvKbps | Should Be "250"
        $options.limitBandwidthInLan | Should Be "true"
        $options.urAccepted | Should Be "-1"
        $options.autoUpgradeIntervalH | Should Be "0"
        $options.crashReportingEnabled | Should Be "false"
        $options.startBrowser | Should Be "false"
    }

    It "with connections.json it writes every listen address in order" {
        $node = New-ConfiguredNode "c002" "ordered"
        Write-ConnectionsFile @{ c002 = $profiled }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be ($listenAddresses -join " ")
    }

    It "without connections.json it listens on the tailnet address only" {
        $node = New-ConfiguredNode "c003" "tailnet-only"
        Write-ConnectionsFile @{ c003 = $profiled }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        Remove-Item -LiteralPath $script:connectionsFile
        Get-NodeConnections $node | Should BeNullOrEmpty
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be "tcp://100.100.1.2:32110"
        $options = Read-ConfigOptions $node
        foreach ($name in @("globalAnnounceEnabled", "localAnnounceEnabled", "relaysEnabled", "natEnabled", "limitBandwidthInLan")) { $options.$name | Should Be "false" }
        $options.maxSendKbps | Should Be "0"
        $options.maxRecvKbps | Should Be "0"
    }

    It "treats a null entry and a non-string listen address as no entry, so the node stays tailnet-only" {
        $node = New-ConfiguredNode "c006" "malformed"
        [System.IO.Directory]::CreateDirectory((Split-Path $script:connectionsFile)) | Out-Null
        [System.IO.File]::WriteAllText($script:connectionsFile, '{ "c006": null }')
        Get-NodeConnections $node | Should BeNullOrEmpty
        Write-ConnectionsFile @{ c006 = @{ options = @{}; listenAddresses = @(32110, "tcp://0.0.0.0:32110"); deviceAddresses = @{} } }
        Get-NodeConnections $node | Should BeNullOrEmpty
        Write-ConnectionsFile @{ c006 = @{ options = @{}; listenAddresses = @("ftp://0.0.0.0:32110"); deviceAddresses = @{} } }
        Get-NodeConnections $node | Should BeNullOrEmpty
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be "tcp://100.100.1.2:32110"
    }

    It "writes only well-typed profile options" {
        $node = New-ConfiguredNode "c007" "typed"
        Write-ConnectionsFile @{ c007 = @{
            options = @{ natEnabled = "yes"; relaysEnabled = $true; maxSendKbps = -5; maxRecvKbps = 1.5; limitBandwidthInLan = 1 }
            listenAddresses = @("tcp://0.0.0.0:32110"); deviceAddresses = @{}
        } }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        $options = Read-ConfigOptions $node
        $options.relaysEnabled | Should Be "true"
        $options.natEnabled | Should Not Be "yes"
        $options.maxSendKbps | Should Be "0"
        $options.maxRecvKbps | Should Be "0"
        $options.limitBandwidthInLan | Should Be "false"
    }

    It "reports no change for the listen addresses it already has, and a change for a reordered list" {
        $options = Read-ConfigOptions (New-ConfiguredNode "c004" "unchanged")
        Set-ListenAddresses $options $listenAddresses | Should Be $true
        Set-ListenAddresses $options $listenAddresses | Should Be $false
        Set-ListenAddresses $options @($listenAddresses[1], $listenAddresses[0]) | Should Be $true
    }

    It "restarts only a tailnet-only node when the tailnet address changes" {
        $instance = New-SyncthingInstance (New-TestNode "c005" "restarts")
        $instance.state = "running"
        $instance.ports = $ports
        $instance.listenAddress = "tcp://0.0.0.0:32110"
        $instance.usesProfile = $true
        Test-NeedsRestartForAddress $instance "100.100.1.3" | Should Be $false
        $instance.usesProfile = $false
        Test-NeedsRestartForAddress $instance "100.100.1.3" | Should Be $true
    }

    Reset-Agent
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}

Describe "the host's networks" {
    It "Get-HostNetworks reports a Public category as Public" {
        $global:ipAddresses = @(
            [pscustomobject]@{ InterfaceIndex = 1; IPAddress = "127.0.0.1" }
            [pscustomobject]@{ InterfaceIndex = 11; IPAddress = "192.168.68.56" }
            [pscustomobject]@{ InterfaceIndex = 12; IPAddress = "100.75.76.90" }
            [pscustomobject]@{ InterfaceIndex = 17; IPAddress = "169.254.145.31" }
            [pscustomobject]@{ InterfaceIndex = 41; IPAddress = "172.29.224.1" }
        )
        $global:connectionProfiles = @(
            [pscustomobject]@{ InterfaceIndex = 11; NetworkCategory = "Public" }
            [pscustomobject]@{ InterfaceIndex = 12; NetworkCategory = "Private" }
        )
        $networks = @(Get-HostNetworks)
        $networks.Count | Should Be 2
        $networks[0].kind | Should Be "lan"
        $networks[0].address | Should Be "192.168.68.56"
        $networks[0].category | Should Be "Public"
        $networks[1].kind | Should Be "tailnet"
        $networks[1].address | Should Be "100.75.76.90"
    }
}
