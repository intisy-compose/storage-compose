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
$global:firewallEvents = @()
$global:programRuleSweeps = @()
$global:tailnetAddress = $null

function Get-TailnetAddress { return $global:tailnetAddress }
function Get-NetFirewallRule([string]$Name) { return $global:firewallRules[$Name] }
function New-NetFirewallRule {
    param([string]$Name, [string]$DisplayName, [string]$Group, [string]$Direction, [string]$Action, [string]$Protocol, $LocalPort, $RemoteAddress, [string]$Program, $Profile)
    $global:firewallRules[$Name] = [pscustomobject]@{
        Name = $Name; Group = $Group; Action = $Action; Protocol = $Protocol; LocalPort = $LocalPort; RemoteAddress = $RemoteAddress; Program = $Program; Profile = "$Profile"
    }
    $global:firewallEvents += "new $Name"
}
function Set-NetFirewallRule {
    param([string]$Name, [string]$Action, [string]$Protocol, $LocalPort, $RemoteAddress, [string]$Program, $Profile)
    $rule = $global:firewallRules[$Name]
    if (-not $rule) { throw "no rule $Name to set" }
    $rule.Action = $Action; $rule.Protocol = $Protocol; $rule.LocalPort = $LocalPort; $rule.RemoteAddress = $RemoteAddress; $rule.Program = $Program; $rule.Profile = "$Profile"
    $global:firewallEvents += "set $Name"
}
function Remove-NetFirewallRule([string]$Name, [string]$Group) {
    if ($Name -and $global:firewallRules.ContainsKey($Name)) { $global:firewallEvents += "remove $Name" }
    if ($Name) { $global:firewallRules.Remove($Name) }
    if ($Group) { foreach ($key in @($global:firewallRules.Keys)) { if ($global:firewallRules[$key].Group -eq $Group) { $global:firewallRules.Remove($key) } } }
}
function Remove-ProgramFirewallRules([string]$Folder) { $global:programRuleSweeps += $Folder }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline = $true)]$Rule) process { [pscustomobject]@{ LocalPort = $Rule.LocalPort; Protocol = $Rule.Protocol } } }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline = $true)]$Rule) process { [pscustomobject]@{ RemoteAddress = $Rule.RemoteAddress } } }
function Get-NetFirewallApplicationFilter { param([Parameter(ValueFromPipeline = $true)]$Rule) process { [pscustomobject]@{ Program = $Rule.Program } } }
$global:ipAddresses = @()
$global:connectionProfiles = @()
function Get-NetIPAddress { [CmdletBinding()] param([string]$AddressFamily) return $global:ipAddresses }
function Get-NetConnectionProfile { [CmdletBinding()] param() return $global:connectionProfiles }
$global:dockerBackendPath = "C:\Program Files\Docker\Docker\resources\com.docker.backend.exe"
function Get-DockerBackendPath { return $global:dockerBackendPath }

function Reset-Agent {
    Stop-AllNodeInstances "test reset"
    $script:syncthingPath = $SyncthingPath
    $script:syncthingSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $SyncthingPath).Hash.ToLower()
    $script:agentState = New-AgentState $null
    $script:logFile = Join-Path $scratch "agent.log"
    $script:connectionsFile = Join-Path $scratch "host-agent\connections\connections.json"
    $global:firewallRules = @{}
    $global:firewallEvents = @()
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

    It "treats a null entry as no entry, so the node stays tailnet-only" {
        $node = New-ConfiguredNode "c006" "malformed"
        [System.IO.Directory]::CreateDirectory((Split-Path $script:connectionsFile)) | Out-Null
        [System.IO.File]::WriteAllText($script:connectionsFile, '{ "c006": null }')
        Get-NodeConnections $node | Should BeNullOrEmpty
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be "tcp://100.100.1.2:32110"
    }

    It "ignores a listen list with any invalid address whole, keeping the profile addresses the config has, and still applies the valid options" {
        $node = New-ConfiguredNode "c008" "kept-listen"
        Write-ConnectionsFile @{ c008 = $profiled }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        foreach ($invalid in @(@(32110, "tcp://0.0.0.0:32110"), @("ftp://0.0.0.0:32110"), @("TCP://0.0.0.0:32110"), "tcp://0.0.0.0:32110", @())) {
            Write-ConnectionsFile @{ c008 = @{ options = @{ relaysEnabled = $false; natEnabled = $false; maxSendKbps = 75 }; listenAddresses = $invalid; deviceAddresses = @{} } }
            Get-NodeConnections $node | Should Not BeNullOrEmpty
            $identity = Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node)
            (Get-ConfiguredListenAddresses $node) -join " " | Should Be ($listenAddresses -join " ")
            $identity.listen.isTailnetOnly | Should Be $false
            $options = Read-ConfigOptions $node
            $options.relaysEnabled | Should Be "false"
            $options.natEnabled | Should Be "false"
            $options.maxSendKbps | Should Be "75"
            Write-ConnectionsFile @{ c008 = $profiled }
            Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        }
    }

    It "takes the address families Syncthing knows" {
        $node = New-ConfiguredNode "c012" "families"
        $families = @("tcp4://0.0.0.0:32110", "tcp6://[::]:32110", "quic4://0.0.0.0:32110", "quic6://[::]:32110")
        Write-ConnectionsFile @{ c012 = @{ options = @{}; listenAddresses = $families; deviceAddresses = @{} } }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be ($families -join " ")
    }

    It "listens on the tailnet address when such a list meets a config without profile addresses, the valid options applied" {
        $node = New-ConfiguredNode "c009" "fresh-invalid"
        Write-ConnectionsFile @{ c009 = @{ options = @{ natEnabled = $true }; listenAddresses = @("udp://0.0.0.0:32110"); deviceAddresses = @{} } }
        $identity = Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node)
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be "tcp://100.100.1.2:32110"
        $identity.listen.isTailnetOnly | Should Be $true
        (Read-ConfigOptions $node).natEnabled | Should Be "true"
        $identity = Set-SyncthingConfig $node $ports "100.100.1.3" (Get-NodeConnections $node)
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be "tcp://100.100.1.3:32110"
    }

    It "a node started on such an entry without profile addresses still moves with the tailnet address" {
        Mock Stop-NodeSyncthingProcesses { }
        Mock Start-SyncthingProcess { return 4243 }
        Mock Get-NodePorts { return $ports }
        $node = New-ConfiguredNode "c010" "start-invalid"
        Write-ConnectionsFile @{ c010 = @{ options = @{ natEnabled = $true }; listenAddresses = @("udp://0.0.0.0:32110"); deviceAddresses = @{} } }
        $instance = New-SyncthingInstance $node
        Start-NodeSyncthing $instance "100.100.1.2"
        $instance.state | Should Be "running"
        $instance.listenAddress | Should Be "tcp://100.100.1.2:32110"
        $instance.usesProfile | Should Be $false
        Test-NeedsRestartForAddress $instance "100.100.1.3" | Should Be $true
    }

    It "a taken-over Syncthing counts as on the profile by the listen addresses its config has" {
        $node = New-ConfiguredNode "c011" "orphan"
        Mock Find-SyncthingProcess { return [pscustomobject]@{ ProcessId = 4244 } }
        Mock Get-NodePorts { return $ports }
        Mock Get-SyncthingDeviceId { return "ORPHAN" }
        Write-ConnectionsFile @{ c011 = @{ options = @{ natEnabled = $true }; listenAddresses = @("udp://0.0.0.0:32110"); deviceAddresses = @{} } }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        $instance = New-SyncthingInstance $node
        Resume-OrphanedSyncthing $instance | Should Be $true
        $instance.usesProfile | Should Be $false
        Write-ConnectionsFile @{ c011 = $profiled }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        $instance = New-SyncthingInstance $node
        Resume-OrphanedSyncthing $instance | Should Be $true
        $instance.usesProfile | Should Be $true
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

function Get-TestRule([string]$NodeId, [string]$Suffix) {
    $name = "storage-compose syncthing $NodeId"
    if ($Suffix) { $name = "$name $Suffix" }
    return $global:firewallRules[$name]
}

function New-ProfileEntry([bool]$LocalAnnounce) {
    return [pscustomobject]@{
        options = [pscustomobject]@{ localAnnounceEnabled = $LocalAnnounce }
        listenAddresses = @("tcp://0.0.0.0:32120", "quic://0.0.0.0:32120")
        deviceAddresses = [pscustomobject]@{}
    }
}

Describe "the firewall per network profile" {
    Reset-Agent
    $ports = [pscustomobject]@{ slot = 0; gui = 18470; listen = 32120 }

    It "on a Public network only the tailnet range is admitted" {
        Set-SyncthingFirewallRule (New-TestNode "d001" "public") $ports (New-ProfileEntry $true)
        foreach ($protocol in @("tcp", "udp")) {
            $rule = Get-TestRule "d001" "$protocol public"
            $rule.Action | Should Be "Allow"
            $rule.Protocol | Should Be $protocol.ToUpper()
            $rule.LocalPort | Should Be 32120
            $rule.RemoteAddress | Should Be "100.64.0.0/10"
            $rule.Profile | Should Be "Public"
            $rule.Program | Should Be $SyncthingPath
            $rule.Group | Should Be "storage-compose agent"
        }
    }

    It "on Private and Domain the sync port is open to any address over TCP and UDP" {
        Set-SyncthingFirewallRule (New-TestNode "d002" "private") $ports (New-ProfileEntry $true)
        foreach ($protocol in @("tcp", "udp")) {
            $rule = Get-TestRule "d002" "$protocol private"
            $rule.Action | Should Be "Allow"
            $rule.Protocol | Should Be $protocol.ToUpper()
            $rule.LocalPort | Should Be 32120
            $rule.RemoteAddress | Should Be "Any"
            $rule.Profile | Should Be "Private,Domain"
            $rule.Group | Should Be "storage-compose agent"
        }
        @($global:firewallRules.Values | Where-Object { $_.Name -like "storage-compose syncthing d002*" -and $_.Action -eq "Block" }).Count | Should Be 0
    }

    It "the old udp block rule is removed" {
        $node = New-TestNode "d003" "upgraded"
        Set-SyncthingFirewallRule $node $ports $null
        Get-TestRule "d003" "udp" | Should Not BeNullOrEmpty
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $true)
        $global:firewallRules.ContainsKey("storage-compose syncthing d003 udp") | Should Be $false
        $global:firewallRules.ContainsKey("storage-compose syncthing d003") | Should Be $false
        Get-TestRule "d003" "tcp private" | Should Not BeNullOrEmpty
    }

    It "a rule whose RemoteAddress changed is changed in place, never removed first" {
        $node = New-TestNode "d004" "replaced"
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $false)
        $rule = Get-TestRule "d004" "tcp public"
        $rule.RemoteAddress = "Any"
        $rule | Add-Member -NotePropertyName marker -NotePropertyValue "original"
        $global:firewallEvents = @()
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $false)
        (Get-TestRule "d004" "tcp public").RemoteAddress | Should Be "100.64.0.0/10"
        (Get-TestRule "d004" "tcp public").marker | Should Be "original"
        $global:firewallEvents | Should Be @("set storage-compose syncthing d004 tcp public")
    }

    It "switching between the tailnet-only and the profile set makes the new rules before it removes the old" {
        $node = New-TestNode "d012" "switched"
        Set-SyncthingFirewallRule $node $ports $null
        foreach ($connections in @((New-ProfileEntry $true), $null)) {
            $global:firewallEvents = @()
            Set-SyncthingFirewallRule $node $ports $connections
            $lastNew = [array]::LastIndexOf([string[]]$global:firewallEvents, @($global:firewallEvents | Where-Object { $_ -like "new *" })[-1])
            $firstRemove = [array]::IndexOf([string[]]$global:firewallEvents, @($global:firewallEvents | Where-Object { $_ -like "remove *" })[0])
            ($lastNew -lt $firstRemove) | Should Be $true
        }
    }

    It "keeps a rule Windows reports with a subnet mask and its profiles in its own order" {
        $node = New-TestNode "d005" "kept"
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $false)
        $public = Get-TestRule "d005" "tcp public"
        $public.RemoteAddress = "100.64.0.0/255.192.0.0"
        $public | Add-Member -NotePropertyName marker -NotePropertyValue "original"
        $private = Get-TestRule "d005" "tcp private"
        $private.Profile = "Domain, Private"
        $private | Add-Member -NotePropertyName marker -NotePropertyValue "original"
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $false)
        (Get-TestRule "d005" "tcp public").marker | Should Be "original"
        (Get-TestRule "d005" "tcp private").marker | Should Be "original"
    }

    It "a tailnet-only node keeps today's rules" {
        Set-SyncthingFirewallRule (New-TestNode "d006" "tailnet-only") $ports $null
        $tcp = Get-TestRule "d006" ""
        $tcp.Action | Should Be "Allow"
        $tcp.Protocol | Should Be "TCP"
        $tcp.LocalPort | Should Be 32120
        $tcp.RemoteAddress | Should Be "100.64.0.0/10"
        $tcp.Profile | Should Be "Any"
        $udp = Get-TestRule "d006" "udp"
        $udp.Action | Should Be "Block"
        $udp.Protocol | Should Be "UDP"
        $udp.Profile | Should Be "Any"
        @($global:firewallRules.Keys | Where-Object { $_ -like "storage-compose syncthing d006*" }).Count | Should Be 2
    }

    It "UDP 21027 only with local announce on" {
        $node = New-TestNode "d007" "discovery"
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $true)
        $rule = Get-TestRule "d007" "discovery private"
        $rule.Protocol | Should Be "UDP"
        $rule.LocalPort | Should Be 21027
        $rule.RemoteAddress | Should Be "Any"
        $rule.Profile | Should Be "Private,Domain"
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $false)
        $global:firewallRules.ContainsKey("storage-compose syncthing d007 discovery private") | Should Be $false
    }

    It "removes every rule of a stopped node, whichever set it had" {
        $node = New-TestNode "d008" "removed"
        Set-SyncthingFirewallRule $node $ports (New-ProfileEntry $true)
        Remove-NodeFirewallRules $node
        @($global:firewallRules.Keys | Where-Object { $_ -like "storage-compose syncthing d008*" }).Count | Should Be 0
    }

    It "follows a profile that arrives while the node runs" {
        $instance = New-SyncthingInstance (New-ConfiguredNode "d009" "arrives")
        $instance.state = "running"
        $instance.ports = $ports
        Update-InstanceFirewall $instance
        Get-TestRule "d009" "udp" | Should Not BeNullOrEmpty
        Write-ConnectionsFile @{ d009 = (New-ProfileEntry $true) }
        Update-InstanceFirewall $instance
        $global:firewallRules.ContainsKey("storage-compose syncthing d009 udp") | Should Be $false
        Get-TestRule "d009" "udp private" | Should Not BeNullOrEmpty
    }

    It "an unreadable connections file leaves the profile rules in place" {
        $instance = New-SyncthingInstance (New-ConfiguredNode "d010" "unreadable")
        $instance.state = "running"
        $instance.ports = $ports
        Write-ConnectionsFile @{ d010 = (New-ProfileEntry $true) }
        Update-InstanceFirewall $instance
        [System.IO.File]::WriteAllText($script:connectionsFile, '{ "d010": { "listenAdd')
        Test-IsUnreadableConnections (Get-NodeConnections $instance.node) | Should Be $true
        Update-InstanceFirewall $instance
        Get-TestRule "d010" "tcp private" | Should Not BeNullOrEmpty
        Get-TestRule "d010" "discovery private" | Should Not BeNullOrEmpty
        $global:firewallRules.ContainsKey("storage-compose syncthing d010 udp") | Should Be $false
        $instance.usesLan | Should Be $true
        Remove-Item -LiteralPath $script:connectionsFile
        Update-InstanceFirewall $instance
        Get-TestRule "d010" "udp" | Should Not BeNullOrEmpty
        $global:firewallRules.ContainsKey("storage-compose syncthing d010 tcp private") | Should Be $false
    }

    It "a start with an unreadable connections file keeps the profile settings and rules" {
        Mock Stop-NodeSyncthingProcesses { }
        Mock Start-SyncthingProcess { return 4242 }
        Mock Get-NodePorts { return $ports }
        $node = New-ConfiguredNode "d011" "unreadable-start"
        $entry = @{
            options = @{ localAnnounceEnabled = $true; relaysEnabled = $true; natEnabled = $true; maxSendKbps = 500 }
            listenAddresses = @("tcp://0.0.0.0:32120", "quic://0.0.0.0:32120", "dynamic+https://relays.syncthing.net/endpoint")
            deviceAddresses = @{}
        }
        Write-ConnectionsFile @{ d011 = $entry }
        Set-SyncthingConfig $node $ports "100.100.1.2" (Get-NodeConnections $node) | Out-Null
        [System.IO.File]::WriteAllText($script:connectionsFile, "")
        $instance = New-SyncthingInstance $node
        Start-NodeSyncthing $instance "100.100.1.2"
        $instance.state | Should Be "running"
        $instance.usesProfile | Should Be $true
        (Get-ConfiguredListenAddresses $node) -join " " | Should Be ($entry.listenAddresses -join " ")
        $options = Read-ConfigOptions $node
        $options.localAnnounceEnabled | Should Be "true"
        $options.relaysEnabled | Should Be "true"
        $options.natEnabled | Should Be "true"
        $options.maxSendKbps | Should Be "500"
        Get-TestRule "d011" "tcp private" | Should Not BeNullOrEmpty
        Get-TestRule "d011" "discovery private" | Should Not BeNullOrEmpty
        $global:firewallRules.ContainsKey("storage-compose syncthing d011 udp") | Should Be $false
    }

    Reset-Agent
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}

Describe "the Docker backend on untrusted networks" {
    Reset-Agent
    $blockNames = @("storage-compose docker backend tcp public", "storage-compose docker backend udp public")
    $outsideTailnet = @("0.0.0.0-100.63.255.255", "100.128.0.0-255.255.255.255", "::-fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff", "fd7a:115c:a1e1::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")

    It "the docker backend is blocked on public networks except from the tailnet" {
        Update-DockerBackendBlock $true
        foreach ($protocol in @("TCP", "UDP")) {
            $rule = $global:firewallRules["storage-compose docker backend $($protocol.ToLower()) public"]
            $rule | Should Not BeNullOrEmpty
            $rule.Action | Should Be "Block"
            $rule.Protocol | Should Be $protocol
            @($rule.LocalPort) -join "," | Should Be "22000,22021-22099,22100"
            @($rule.RemoteAddress) -join "," | Should Be ($outsideTailnet -join ",")
            $rule.Profile | Should Be "Public"
            $rule.Program | Should Be $global:dockerBackendPath
            $rule.Group | Should Be "storage-compose agent"
        }
    }

    It "the block rule is not rewritten when unchanged" {
        Update-DockerBackendBlock $true
        foreach ($name in $blockNames) { $global:firewallRules[$name] | Add-Member -Force -NotePropertyName marker -NotePropertyValue "original" }
        Update-DockerBackendBlock $true
        $script:dockerBackendBlockShape = $null
        foreach ($name in $blockNames) {
            $rule = $global:firewallRules[$name]
            $rule.LocalPort = @("22000", "22021-22099", "22100")
            $rule.RemoteAddress = @($outsideTailnet[3], $outsideTailnet[1], $outsideTailnet[0], $outsideTailnet[2])
            $rule.Program = $global:dockerBackendPath.ToLower()
        }
        Update-DockerBackendBlock $true
        foreach ($name in $blockNames) { $global:firewallRules[$name].marker | Should Be "original" }
        $global:firewallRules[$blockNames[0]].RemoteAddress = @("Any")
        $script:dockerBackendBlockShape = $null
        $global:firewallEvents = @()
        Update-DockerBackendBlock $true
        @($global:firewallRules[$blockNames[0]].RemoteAddress) -join "," | Should Be ($outsideTailnet -join ",")
        $global:firewallEvents | Should Be @("set $($blockNames[0])")
        $global:firewallRules[$blockNames[1]].marker | Should Be "original"
    }

    It "the block rule is removed with the agent" {
        Update-DockerBackendBlock $true
        Remove-SyncthingFirewallRules
        foreach ($name in $blockNames) { $global:firewallRules.ContainsKey($name) | Should Be $false }
        Update-DockerBackendBlock $true
        $global:firewallRules.ContainsKey($blockNames[0]) | Should Be $true
        Update-DockerBackendBlock $false
        foreach ($name in $blockNames) { $global:firewallRules.ContainsKey($name) | Should Be $false }
    }

    Reset-Agent
}

Describe "the host's networks" {
    It "reports a LAN marked Public while a node uses the LAN method" {
        $networks = @(
            [pscustomobject]@{ kind = "lan"; address = "192.168.68.56"; category = "Public"; name = "Network 3" }
            [pscustomobject]@{ kind = "lan"; address = "10.0.0.5"; category = "Private"; name = "Home" }
            [pscustomobject]@{ kind = "tailnet"; address = "100.75.76.90" }
        )
        $withLan = [pscustomobject]@{ state = "running"; usesLan = $true }
        $withoutLan = [pscustomobject]@{ state = "running"; usesLan = $false }
        @(Get-LanProblems $networks @($withLan)) | Should Be @("LAN unavailable: Network 3 (192.168.68.56) is marked Public")
        @(Get-LanProblems $networks @($withoutLan)).Count | Should Be 0
    }

    It "Get-HostNetworks reports a Public category as Public" {
        $global:ipAddresses = @(
            [pscustomobject]@{ InterfaceIndex = 1; IPAddress = "127.0.0.1" }
            [pscustomobject]@{ InterfaceIndex = 11; IPAddress = "192.168.68.56" }
            [pscustomobject]@{ InterfaceIndex = 12; IPAddress = "100.75.76.90" }
            [pscustomobject]@{ InterfaceIndex = 17; IPAddress = "169.254.145.31" }
            [pscustomobject]@{ InterfaceIndex = 41; IPAddress = "172.29.224.1" }
        )
        $global:connectionProfiles = @(
            [pscustomobject]@{ InterfaceIndex = 11; NetworkCategory = "Public"; Name = "Network 3" }
            [pscustomobject]@{ InterfaceIndex = 12; NetworkCategory = "Private" }
        )
        $networks = @(Get-HostNetworks)
        $networks.Count | Should Be 2
        $networks[0].kind | Should Be "lan"
        $networks[0].address | Should Be "192.168.68.56"
        $networks[0].category | Should Be "Public"
        $networks[0].name | Should Be "Network 3"
        $networks[1].kind | Should Be "tailnet"
        $networks[1].address | Should Be "100.75.76.90"
    }
}
