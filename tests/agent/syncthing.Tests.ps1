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

function Reset-Agent {
    Stop-AllNodeInstances "test reset"
    $script:syncthingPath = $SyncthingPath
    $script:syncthingSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $SyncthingPath).Hash.ToLower()
    $script:agentState = New-AgentState $null
    $script:logFile = Join-Path $scratch "agent.log"
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
