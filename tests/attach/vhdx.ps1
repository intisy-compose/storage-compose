#Requires -Version 5.1
<#
.SYNOPSIS
End to end without admin and without a physical disk: three dynamic VHDX test disks (a GPT "Linux
filesystem" partition labelled wslt-data1, one labelled otherwise, a blank one) are passed through
to Docker Desktop's VM with the watcher's own `wsl --mount --vhd --bare` call, the watcher's
publisher writes the host's SMART reports into a test volume, and the mounter and dashboard images
built from this checkout show what they take from it. Needs Docker Desktop on WSL2; leaves nothing
behind.
#>
param([string]$Scratch = (Join-Path ([System.IO.Path]::GetTempPath()) "storage-wsl-vhdx-test"))

Set-StrictMode -Version Latest
$here = $PSScriptRoot
$repository = Split-Path (Split-Path $here)
. (Join-Path $repository "windows\passthrough.ps1")

$prefix = "wslt"
$labelledTableId = "5e1f0c2a-7b3d-4c9e-8a61-0d2f4b6c8e10"
$labelledSizeMegabytes = 64
$blankSizeMegabytes = 80
$blankSizeBytes = [uint64]$blankSizeMegabytes * 1MB
$otherTableId = "6a2b1d3e-8c4f-4d0a-9b72-1e3f5a7c9d21"
$otherSizeMegabytes = 72
$labelledVhdx = Join-Path $Scratch "wslt-data1.vhdx"
$otherVhdx = Join-Path $Scratch "wslt-other.vhdx"
$blankVhdx = Join-Path $Scratch "wslt-blank.vhdx"
$volume = "storage-wsltest-status"
$mounterImage = "storage-mounter:wsltest"
$dashboardImage = "storage-dashboard:wsltest"
$testDiskImage = "storage-test-disk:wsltest"
$script:passed = 0
$script:failed = 0

function Test-Expectation([string]$What, $Expected, $Actual) {
    if ("$Expected" -eq "$Actual") { Write-Host "  PASS $What`: $Actual" -ForegroundColor Green; $script:passed++ }
    else { Write-Host "  FAIL $What`: expected '$Expected', got '$Actual'" -ForegroundColor Red; $script:failed++ }
}

function Invoke-Docker([string[]]$Arguments, [string]$InputText) {
    $result = Invoke-NativeCommand "docker" $Arguments $InputText
    if ($result.ExitCode -ne 0) { throw "docker $($Arguments -join ' ') failed: $($result.Output)" }
    return $result.Output
}

function New-TestDisk([string]$Path, [int]$SizeMegabytes, [string]$Label, [string]$TableId) {
    $folder = Split-Path $Path
    Invoke-Docker @("run", "--rm", "-v", "${folder}:/out", $testDiskImage, "/out/$(Split-Path -Leaf $Path)", "$SizeMegabytes", $Label, $TableId) | Out-Null
}

function New-FakeSmartReport([string]$Serial) {
    return [pscustomobject]@{
        serial_number = $Serial; model_name = "WSL test disk"; smart_status = [pscustomobject]@{ passed = $true }
        ata_smart_attributes = [pscustomobject]@{ table = @([pscustomobject]@{ id = 5; raw = [pscustomobject]@{ value = 0 } }) }
    }
}

function New-TestState {
    $state = New-WatcherState $null
    $labelled = ConvertTo-PassedDisk ([pscustomobject]@{ number = 90; guid = $labelledTableId; size = [uint64]$labelledSizeMegabytes * 1MB; source = "rule"; smart = (New-FakeSmartReport "WSLT-LABELLED") })
    $blank = ConvertTo-PassedDisk ([pscustomobject]@{ number = 91; guid = $null; size = $blankSizeBytes; source = "attach"; smart = (New-FakeSmartReport "WSLT-BLANK") })
    $other = ConvertTo-PassedDisk ([pscustomobject]@{ number = 92; guid = $otherTableId; size = [uint64]$otherSizeMegabytes * 1MB; source = "rule" })
    $state.disks = @($labelled, $blank, $other)
    return $state
}

function Get-ProbeValues([string]$Output) {
    $values = @{}
    foreach ($line in $Output -split "`n") { if ($line -match '^([a-z_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() } }
    return $values
}

function Invoke-MounterProbe {
    return Get-ProbeValues (Invoke-Docker @("run", "--rm", "--privileged", "-e", "ARRAY_PREFIX=$prefix", "-v", "/dev:/dev", "-v", "${volume}:/status",
        "-v", "${here}:/tests:ro", "--entrypoint", "bash", $mounterImage, "/tests/mounter-probe.sh", "$blankSizeBytes"))
}

function Invoke-DashboardProbe([string]$LabelledPartition) {
    $output = Invoke-Docker @("run", "--rm", "--privileged", "-e", "ARRAY_PREFIX=$prefix", "-e", "CANDIDATE_TRANSPORTS=wsl", "-v", "/dev:/dev",
        "-v", "${volume}:/status", "-v", "${here}:/tests:ro", "--entrypoint", "node", $dashboardImage, "/tests/dashboard-probe.mjs", $LabelledPartition)
    return $output | ConvertFrom-Json
}

function Wait-ForVmDisk {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $found = Invoke-Docker @("run", "--rm", "--privileged", $probeImage, "sh", "-c", "blkid -c /dev/null -t LABEL=$prefix-data1 -o device || true")
        if ($found) { return }
        Start-Sleep -Seconds 1
    }
    throw "the labelled test disk did not appear in the VM"
}

function Remove-TestDisks {
    foreach ($path in @($labelledVhdx, $otherVhdx, $blankVhdx)) { Dismount-WslDisk $path | Out-Null }
    Invoke-NativeCommand "docker" @("volume", "rm", "-f", $volume) | Out-Null
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Scratch
}

function Remove-TestImages { Invoke-NativeCommand "docker" @("image", "rm", $mounterImage, $dashboardImage, $testDiskImage) | Out-Null }

function Test-PassThrough {
    Write-Host "Passing the VHDX disks through with the watcher's wsl --mount call..." -ForegroundColor Cyan
    Test-Expectation "labelled disk mounted" 0 (Mount-WslDisk $labelledVhdx -Vhd).ExitCode
    Test-Expectation "mounted again while already attached (detached and attached)" 0 (Mount-WslDisk $labelledVhdx -Vhd).ExitCode
    Test-Expectation "blank disk mounted" 0 (Mount-WslDisk $blankVhdx -Vhd).ExitCode
    Test-Expectation "otherwise labelled disk mounted" 0 (Mount-WslDisk $otherVhdx -Vhd).ExitCode
    Wait-ForVmDisk
}

function Test-Mounter {
    Write-Host "What the mounter takes..." -ForegroundColor Cyan
    $probe = Invoke-MounterProbe
    Test-Expectation "the labelled disk's report, found by its GPT id" "WSLT-LABELLED" $probe["labelled_serial"]
    Test-Expectation "the blank disk's report, found by its size" "WSLT-BLANK" $probe["blank_serial"]
    Test-Expectation "disk-labels names the labelled disk" $true ($probe["disk_labels"] -match "$labelledTableId labelled")
    Test-Expectation "disk-labels names the otherwise labelled disk, which up hands back" $true ($probe["disk_labels"] -match "$otherTableId unlabelled")
    Test-Expectation "disk-labels leaves the blank disk out (no GPT id)" 1 ([regex]::Matches($probe["disk_labels"], "unlabelled").Count)
    return $probe
}

function Test-Dashboard([string]$LabelledPartition, [string]$BlankDisk) {
    Write-Host "What the dashboard offers and shows..." -ForegroundColor Cyan
    $probe = Invoke-DashboardProbe $LabelledPartition
    $candidates = @($probe.candidates)
    Test-Expectation "replacement candidates on transport wsl" 1 $candidates.Count
    Test-Expectation "the candidate is the blank disk attach passed through" $BlankDisk @($candidates.path)[0]
    Test-Expectation "its transport" "wsl" @($candidates.transport)[0]
    Test-Expectation "the labelled disk's SMART comes from the host" "WSLT-LABELLED" $probe.labelledSerial
}

function Test-StaleFile {
    Write-Host "A file left over from an earlier run..." -ForegroundColor Cyan
    $old = Get-PublishedDisks (New-TestState)
    $old.updatedEpoch = (Get-UnixSeconds) - 3600
    $json = ConvertTo-Json -InputObject $old -Depth 30 -Compress
    Invoke-Docker @("run", "--rm", "-i", "-v", "${volume}:/status", $probeImage, "sh", "-c", "sed '1s/^\xEF\xBB\xBF//' > /status/wsl-disks.json") $json | Out-Null
    Test-Expectation "the mounter ignores it" "" (Invoke-MounterProbe)["labelled_serial"]
}

$global:OutputEncoding = New-Object System.Text.UTF8Encoding $false
Remove-TestDisks
New-Item -ItemType Directory -Force -Path $Scratch | Out-Null
try {
    Write-Host "Building the mounter and dashboard images from this checkout, and the test disks..." -ForegroundColor Cyan
    Invoke-Docker @("build", "-q", "-t", $mounterImage, (Join-Path $repository "images\mounter")) | Out-Null
    Invoke-Docker @("build", "-q", "-t", $testDiskImage, (Join-Path $here "test-disk")) | Out-Null
    Invoke-Docker @("build", "-q", "-t", $dashboardImage, "-f", (Join-Path $repository "images\dashboard\Dockerfile"), (Join-Path $repository "images")) | Out-Null
    New-TestDisk $labelledVhdx $labelledSizeMegabytes "$prefix-data1" $labelledTableId
    New-TestDisk $blankVhdx $blankSizeMegabytes "blank" ""
    New-TestDisk $otherVhdx $otherSizeMegabytes "scratch" $otherTableId
    Invoke-Docker @("volume", "create", $volume) | Out-Null
    Test-PassThrough
    Test-Expectation "the watcher's publisher wrote wsl-disks.json" $true (Publish-WslDisks (New-TestState) $volume)
    $probe = Test-Mounter
    Test-Dashboard $probe["labelled_partition"] $probe["blank_disk"]
    Test-StaleFile
} finally {
    Remove-TestDisks
    Remove-TestImages
}
Write-Host ""
Write-Host "$script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
