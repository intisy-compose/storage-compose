# Names the host agent, its installer and the CLI share. Dot-sourced; defines values only.

$agentServiceName = "storage-compose-agent"
$agentServiceDisplayName = "storage-compose host agent"
$agentInstallFolder = Join-Path $env:ProgramFiles "storage-compose-agent"
$agentScriptNames = @("agent.ps1", "agent-files.ps1", "disks.ps1", "passthrough.ps1", "nodes.ps1", "syncthing.ps1")
$agentServiceSourceName = "service\AgentService.cs"
$agentExecutableName = "storage-compose-agent.exe"
$agentConfigName = "agent-config.json"
$agentMutexName = "Global\storage-compose-agent"
$agentFirewallGroup = "storage-compose agent"
$agentRemovedItselfExitCode = 3

$agentFolderName = "host-agent"
$agentStatusFolderName = "status"
$agentHeartbeatName = "heartbeat.json"
$agentStateName = "state.json"
$agentLogName = "agent.log"

$syncthingVersion = "v2.1.6"
$syncthingArchiveHashes = @{
    amd64 = "589098269cabb9a5a1703a934305b4153609d7623e978e1c94f0f49d77ae5e9f"
    arm64 = "ddb25a3cf556157e329263bd3331d889ea7bb952b85a5f530320175105bab072"
}
$syncthingGuiPortBase = 8450
$syncthingListenPortBase = 22001
$syncthingPortCount = 20
$tailnetAddressRange = "100.64.0.0/10"

function Get-AgentFolder([string]$StackFolder) { return Join-Path $StackFolder $agentFolderName }

function Get-AgentStatusFolder([string]$StackFolder) { return Join-Path (Get-AgentFolder $StackFolder) $agentStatusFolderName }

function Get-SyncthingArchitecture {
    if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { return "arm64" }
    return "amd64"
}

function Get-SyncthingFolder([string]$StackFolder) {
    return Join-Path (Get-AgentFolder $StackFolder) "bin\syncthing-$syncthingVersion-windows-$(Get-SyncthingArchitecture)"
}

function Get-SyncthingPath([string]$StackFolder) { return Join-Path (Get-SyncthingFolder $StackFolder) "syncthing.exe" }

function Test-IsPathUnder([string]$Path, [string]$Folder) {
    if (-not $Path -or -not $Folder) { return $false }
    $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
    $prefix = [System.IO.Path]::GetFullPath($Folder).TrimEnd('\') + '\'
    return $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

<#
.NOTES
Removes every inbound rule for a program below the folder, the agent's own and any Windows made
when it asked "allow access?" for one of these binaries (RULES.md section 2: nothing outlives the
stack). Windows writes such rules with the path in lower case, so paths compare without case.
#>
function Remove-ProgramFirewallRules([string]$Folder) {
    if (-not $Folder) { return }
    Get-NetFirewallApplicationFilter -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Program -and $_.Program -ne "Any" -and (Test-IsPathUnder $_.Program $Folder) } |
        ForEach-Object { $_ | Get-NetFirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
}
