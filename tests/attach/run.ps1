#Requires -Version 5.1
<#
.SYNOPSIS
The tests of the WSL pass-through (docs specs/2026-10-11-wsl-passthrough.md): the disk selection and
the attach watcher against fakes (Pester 3.4, shipped with Windows), then, unless -UnitOnly, the
VHDX test on Docker Desktop. None of them needs admin or touches a physical disk.
#>
param([switch]$UnitOnly, [string]$Scratch)

Import-Module Pester -MinimumVersion 3.4.0
$result = Invoke-Pester -Script @((Join-Path $PSScriptRoot "disks.Tests.ps1"), (Join-Path $PSScriptRoot "watcher.Tests.ps1")) -PassThru
if ($result.FailedCount -gt 0) { exit 1 }
if ($UnitOnly) { exit 0 }
$vhdxArguments = @{}
if ($Scratch) { $vhdxArguments["Scratch"] = $Scratch }
& (Join-Path $PSScriptRoot "vhdx.ps1") @vhdxArguments
exit $LASTEXITCODE
