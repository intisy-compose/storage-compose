# Pester 3.4: when the agent stops starting a node's Syncthing again. The process, its config and the
# firewall are faked, so no Syncthing runs and nothing on the host is touched.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-backoff-$([guid]::NewGuid())"
$global:processStarts = 0

function Test-SyncthingBinary { return $null }
function Get-TailnetAddress { return "127.0.0.1" }
function Stop-NodeSyncthingProcesses($Node) { }
function Get-NodePorts($Node) { return [pscustomobject]@{ slot = 0; gui = 18490; listen = 32190 } }
function New-SyncthingConfig($Node) { }
function Set-SyncthingConfig($Node, $Ports, [string]$ListenHost) { return [pscustomobject]@{ apiKey = "test-key"; deviceId = "TEST" } }
function Set-SyncthingFirewallRule($Node, $Ports) { }
function Start-SyncthingProcess($Node) { $global:processStarts++; return 0 }
function Test-ProcessIsRunning($ProcessId) { return $false }
function Write-WatcherLog([string]$Text) { }

<#
.SYNOPSIS
A node whose Syncthing was started three times in the last minutes and has just exited, after running
for $RanSeconds.
#>
function New-ExitedInstance([int]$RanSeconds) {
    $root = Join-Path $scratch "node"
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $node = [pscustomobject]@{ id = "b001"; name = "backoff-node"; kind = "folder"; threshold = 80; assigned = @(); root = $root }
    $instance = New-SyncthingInstance $node
    $instance.ports = Get-NodePorts $node
    $instance.listenAddress = "tcp://127.0.0.1:32190"
    $instance.state = "running"
    $instance.startedAt = (Get-Date).AddSeconds(-$RanSeconds).ToString("o")
    $instance.attempts = @((Get-Date).AddSeconds(-400), (Get-Date).AddSeconds(-300), (Get-Date).AddSeconds(-$RanSeconds))
    $script:syncthingInstances = @{ b001 = $instance }
    $global:processStarts = 0
    return $node
}

Describe "a node's Syncthing that exits" {
    It "is started again after a run of at least a minute, however often it was started before" {
        $node = New-ExitedInstance 120
        Update-NodeInstances @($node) $true | Out-Null
        $script:syncthingInstances["b001"].state | Should Be "running"
        $global:processStarts | Should Be 1
        @($script:syncthingInstances["b001"].attempts).Count | Should Be 1
    }

    It "backs off after three starts when each run ended within a minute" {
        $node = New-ExitedInstance 10
        Update-NodeInstances @($node) $true | Out-Null
        $script:syncthingInstances["b001"].state | Should Be "failed"
        $global:processStarts | Should Be 0
    }

    $script:syncthingInstances = @{}
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}
