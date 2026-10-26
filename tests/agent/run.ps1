#Requires -Version 5.1
<#
.SYNOPSIS
The host agent's tests: node discovery, the agent's rounds and lifetime, the installer and the native
Syncthings (Pester 3.4, shipped with Windows; the Syncthing tests run the real pinned binary, fetched
once into host-agent\bin and run from a copy), then, unless -UnitOnly, the VHDX end to end in this
shell (admin, for diskpart). -Service adds the one test that registers the real service; nothing else
does.
#>
param([switch]$UnitOnly, [switch]$Service)

Set-StrictMode -Version Latest
$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\disks.ps1")
. (Join-Path $repository "windows\agent-files.ps1")
. (Join-Path $repository "windows\agent-install.ps1")

$testRunFolder = Join-Path ([System.IO.Path]::GetTempPath()) "storage-compose-agent-tests-$([guid]::NewGuid())"
$testBinFolder = Join-Path $testRunFolder "bin"

<#
.NOTES
The agent finds its Syncthings by the binary's path and sweeps every firewall rule for a program in
its bin folder, and the tests do the same with the binary they are given. host-agent\bin of the stack
folder holds the binary the installed agent runs, so the tests get a copy of their own per run.
#>
function Copy-TestSyncthing([string]$Binary) {
    $folder = Join-Path $testBinFolder (Split-Path -Leaf (Split-Path $Binary))
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Copy-Item -LiteralPath $Binary -Destination $folder
    return Join-Path $folder (Split-Path -Leaf $Binary)
}

<#
.NOTES
The tests run the binary as this user without the agent's rules (they fake the firewall), so
Windows may add an "allow access" rule for it; every run, a failed or interrupted one too, ends by
sweeping the copy's rules and the guard's.
#>
function Remove-TestRun {
    Remove-ProgramFirewallRules $testBinFolder
    Remove-NetFirewallRule -Group "storage-compose test guard" -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $testRunFolder
    if (Test-Path -LiteralPath $testRunFolder) { Write-Warning "$testRunFolder is still there (a syncthing.exe of the run still holds it); remove it by hand" }
}

function Invoke-AgentTests([string]$Syncthing) {
    $scripts = @(
        (Join-Path $PSScriptRoot "nodes.Tests.ps1"),
        (Join-Path $PSScriptRoot "firewall.Tests.ps1"),
        (Join-Path $PSScriptRoot "agent.Tests.ps1"),
        (Join-Path $PSScriptRoot "install.Tests.ps1"),
        @{ Path = (Join-Path $PSScriptRoot "syncthing.Tests.ps1"); Parameters = @{ SyncthingPath = $Syncthing } }
    )
    $result = Invoke-Pester -Script $scripts -PassThru
    if ($result.FailedCount -gt 0) { return 1 }
    if ($UnitOnly) { return 0 }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "vhdx-nodes.ps1") -SyncthingPath $Syncthing | Out-Host
    if ($LASTEXITCODE -ne 0) { return 1 }
    if (-not $Service) { return 0 }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "service.ps1") -SyncthingPath $Syncthing | Out-Host
    return $LASTEXITCODE
}

$exitCode = 1
try {
    $syncthing = Copy-TestSyncthing (Get-SyncthingBinary $repository)
    . (Join-Path $PSScriptRoot "firewall-guard.ps1")
    Add-TestFirewallGuard $syncthing
    Import-Module Pester -MinimumVersion 3.4.0
    $exitCode = Invoke-AgentTests $syncthing
} finally {
    Remove-TestRun
}
exit $exitCode
