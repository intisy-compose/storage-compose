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
its bin folder, and so do the tests. Run from the checkout that is the stack folder, the binary in
host-agent\bin is the one the installed agent runs, so the tests ended the live node's Syncthing and
removed its firewall rules; a copy per run keeps them to their own processes and rules.
#>
function Copy-TestSyncthing([string]$Binary) {
    $folder = Join-Path $testBinFolder (Split-Path -Leaf (Split-Path $Binary))
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Copy-Item -LiteralPath $Binary -Destination $folder
    return Join-Path $folder (Split-Path -Leaf $Binary)
}

$syncthing = Copy-TestSyncthing (Get-SyncthingBinary $repository)
. (Join-Path $PSScriptRoot "firewall-guard.ps1")
Add-TestFirewallGuard $syncthing
Import-Module Pester -MinimumVersion 3.4.0

<#
.NOTES
The tests run the binary as this user without the agent's rules (they fake the firewall), so
Windows may add an "allow access" rule for it; every run ends by sweeping the copy's rules.
#>
function Complete-Run([int]$Code) {
    Remove-ProgramFirewallRules $testBinFolder
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -LiteralPath $testRunFolder
    exit $Code
}

$scripts = @(
    (Join-Path $PSScriptRoot "nodes.Tests.ps1"),
    (Join-Path $PSScriptRoot "firewall.Tests.ps1"),
    (Join-Path $PSScriptRoot "agent.Tests.ps1"),
    (Join-Path $PSScriptRoot "install.Tests.ps1"),
    @{ Path = (Join-Path $PSScriptRoot "syncthing.Tests.ps1"); Parameters = @{ SyncthingPath = $syncthing } }
)
$result = Invoke-Pester -Script $scripts -PassThru
if ($result.FailedCount -gt 0) { Complete-Run 1 }
if ($UnitOnly) { Complete-Run 0 }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "vhdx-nodes.ps1") -SyncthingPath $syncthing
if ($LASTEXITCODE -ne 0) { Complete-Run 1 }
if (-not $Service) { Complete-Run 0 }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "service.ps1") -SyncthingPath $syncthing
Complete-Run $LASTEXITCODE
