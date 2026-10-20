#Requires -Version 5.1
<#
.SYNOPSIS
The host agent's tests: node discovery, the agent's rounds and lifetime, the installer and the native
Syncthings (Pester 3.4, shipped with Windows; the Syncthing tests run the real pinned binary, fetched
once into host-agent\bin), then, unless -UnitOnly, the VHDX end to end in this shell (admin, for
diskpart). -Service adds the one test that registers the real service; nothing else does.
#>
param([switch]$UnitOnly, [switch]$Service)

Set-StrictMode -Version Latest
$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\disks.ps1")
. (Join-Path $repository "windows\agent-files.ps1")
. (Join-Path $repository "windows\agent-install.ps1")

$syncthing = Get-SyncthingBinary $repository
Import-Module Pester -MinimumVersion 3.4.0
$scripts = @(
    (Join-Path $PSScriptRoot "nodes.Tests.ps1"),
    (Join-Path $PSScriptRoot "agent.Tests.ps1"),
    (Join-Path $PSScriptRoot "install.Tests.ps1"),
    @{ Path = (Join-Path $PSScriptRoot "syncthing.Tests.ps1"); Parameters = @{ SyncthingPath = $syncthing } }
)
$result = Invoke-Pester -Script $scripts -PassThru
if ($result.FailedCount -gt 0) { exit 1 }
if ($UnitOnly) { exit 0 }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "vhdx-nodes.ps1") -SyncthingPath $syncthing
if ($LASTEXITCODE -ne 0) { exit 1 }
if (-not $Service) { exit 0 }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "service.ps1") -SyncthingPath $syncthing
exit $LASTEXITCODE
