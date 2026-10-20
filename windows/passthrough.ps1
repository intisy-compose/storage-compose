# The WSL pass-through of the array's USB disks (docs specs/2026-10-11-wsl-passthrough.md), run by the
# host agent: passes them through to Docker Desktop's WSL VM with `wsl --mount --bare` while the stack
# is up, hands them back after a drop or a VM restart, and reads their SMART counts for the VM, which
# cannot. Dot-sourced by the agent and the tests; defines functions only.

Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "disks.ps1")

$roundSeconds = 5
$smartIntervalSeconds = 600
$publishIntervalSeconds = 600
$attemptWindowSeconds = 600
$attemptsPerWindow = 3
$dockerDistribution = "docker-desktop"
$probeImage = "debian:trixie-slim"
$wslTimeoutSeconds = 120
$projectName = "storage-compose"
$userRelay = $null
$logFile = $null
$userSid = $null
$logLimitBytes = 1MB
$attempts = @{}
$lastPublished = [datetime]::MinValue
$publishIsDue = $true

function Write-WatcherLog([string]$Message) {
    if (-not $script:logFile) { return }
    if ((Test-Path $script:logFile) -and (Get-Item $script:logFile).Length -gt $logLimitBytes) {
        Move-Item -Force -Path $script:logFile -Destination "$script:logFile.old"
    }
    Add-Content -Path $script:logFile -Value "$((Get-Date).ToString('s')) $Message"
}

function Add-Problem($State, [string]$Message) {
    $State.problems = @($State.problems) + $Message
    Write-WatcherLog $Message
}

<#
.NOTES
wsl.exe and docker write their notes to stderr; Windows PowerShell 5.1 turns redirected stderr into
errors, so the output is collected as text and judged by the exit code.
#>
function Invoke-NativeCommand([string]$FilePath, [string[]]$Arguments, [string]$InputText) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($InputText) { $output = $InputText | & $FilePath @Arguments 2>&1 | ForEach-Object { "$_" } }
        else { $output = & $FilePath @Arguments 2>&1 | ForEach-Object { "$_" } }
        return [pscustomobject]@{ Output = (@($output) -join "`n").Trim(); ExitCode = $LASTEXITCODE }
    } catch {
        return [pscustomobject]@{ Output = "$_"; ExitCode = -1 }
    } finally {
        $ErrorActionPreference = $previous
    }
}

<#
.NOTES
wsl.exe writes UTF-16 unless WSL_UTF8 is set. The agent runs as SYSTEM, which WSL refuses, so it runs
wsl.exe as the user whose Docker Desktop owns the VM, through the service's relay.
#>
function Invoke-Wsl([string[]]$Arguments) {
    $env:WSL_UTF8 = "1"
    if (-not $script:userRelay) { return Invoke-NativeCommand "wsl.exe" $Arguments }
    $relayArguments = @("run-as-user", $script:userSid, "$wslTimeoutSeconds", "--env", "WSL_UTF8=1", "--", "wsl.exe") + $Arguments
    return Invoke-NativeCommand $script:userRelay $relayArguments
}

<#
.NOTES
A disk passed through is gone once the VM restarts, which a new boot id shows. The VM is only asked
while Docker Desktop's distribution runs, so the watcher never starts it.
#>
function Get-DockerVmBootId {
    $running = Invoke-Wsl @("--list", "--running", "--quiet")
    if ($running.ExitCode -ne 0) { return $null }
    $distributions = @($running.Output -split "`n" | ForEach-Object { $_.Trim([char]0).Trim() })
    if ($distributions -notcontains $dockerDistribution) { return $null }
    $bootId = Invoke-Wsl @("-d", $dockerDistribution, "cat", "/proc/sys/kernel/random/boot_id")
    if ($bootId.ExitCode -ne 0 -or -not $bootId.Output) { return $null }
    return $bootId.Output.Trim()
}

function Get-PhysicalDrivePath([int]$Number) { return "\\.\PHYSICALDRIVE$Number" }

function Test-IsAlreadyAttached($Result) { return $Result.ExitCode -ne 0 -and $Result.Output -match "ALREADY_ATTACHED" }

<#
.NOTES
WSL keeps a disk that vanished from under it on its list, so a drive back under the same number is
detached before it is attached again.
#>
function Mount-WslDisk([string]$Path, [switch]$Vhd) {
    $arguments = @("--mount")
    if ($Vhd) { $arguments += "--vhd" }
    $arguments += @($Path, "--bare")
    $result = Invoke-Wsl $arguments
    if (Test-IsAlreadyAttached $result) {
        Dismount-WslDisk $Path | Out-Null
        $result = Invoke-Wsl $arguments
    }
    return $result
}

function Dismount-WslDisk([string]$Path) { return Invoke-Wsl @("--unmount", $Path) }

function Set-DiskOffline($Disk) { if (-not $Disk.IsOffline) { Set-Disk -Number $Disk.Number -IsOffline $true -ErrorAction Stop } }

function Set-DiskOnline([int]$Number) { Set-Disk -Number $Number -IsOffline $false -ErrorAction Stop }

function ConvertTo-PassedDisk($Saved) {
    $disk = [pscustomobject]@{
        number = 0; uniqueId = ""; size = [uint64]0; guid = $null; model = ""; serial = ""; source = "rule"
        wasOnline = $false; attachedAt = $null; smart = $null; smartCheckedAt = $null; smartTriedAt = $null
    }
    foreach ($property in $Saved.PSObject.Properties) {
        if ($disk.PSObject.Properties[$property.Name]) { $disk.($property.Name) = $property.Value }
    }
    $disk.size = [uint64]$disk.size
    return $disk
}

function New-PassedDisk($Disk, [string]$Source) {
    $identity = Get-DiskIdentity $Disk
    return ConvertTo-PassedDisk ([pscustomobject]@{
        number = $identity.Number; uniqueId = $identity.UniqueId; size = $identity.Size; guid = $identity.Guid
        model = "$($Disk.FriendlyName)".Trim(); serial = "$($Disk.SerialNumber)".Trim(); source = $Source
        wasOnline = -not $Disk.IsOffline; attachedAt = (Get-Date).ToString("o")
    })
}

function New-WatcherState($Saved) {
    $state = [pscustomobject]@{
        heartbeat = $null; vmBootId = $null; handledRequest = $null; disks = @(); problems = @(); requestProblems = @()
    }
    if (-not $Saved) { return $state }
    foreach ($name in @("vmBootId", "handledRequest")) {
        if ($Saved.PSObject.Properties[$name]) { $state.$name = $Saved.$name }
    }
    if ($Saved.PSObject.Properties["disks"]) { $state.disks = @($Saved.disks | Where-Object { $_ } | ForEach-Object { ConvertTo-PassedDisk $_ }) }
    return $state
}

<#
.NOTES
A request file that exists but cannot be read (the CLI is replacing it) returns $null and the round
leaves everything as it is; only a missing file means "not active", or a sharing violation would
pull every drive out from under the running array.
#>
function Read-AttachRequest {
    $request = [pscustomobject]@{ id = $null; active = $false; attach = @(); release = @() }
    if (-not (Test-Path $script:requestFile)) { return $request }
    $saved = Read-JsonFile $script:requestFile
    if (-not $saved) { return $null }
    foreach ($property in $saved.PSObject.Properties) {
        if ($request.PSObject.Properties[$property.Name]) { $request.($property.Name) = $property.Value }
    }
    $request.attach = @($request.attach | Where-Object { $_ })
    $request.release = @($request.release | Where-Object { $_ } | ForEach-Object { "$_".ToLower() })
    return $request
}

function Get-AttemptKey($Disk) { return "$($Disk.UniqueId)|$($Disk.Size)" }

<#
.NOTES
A drive that fails to attach, or keeps vanishing right after it was attached, is left alone for a
while instead of being toggled offline and online every round.
#>
function Test-IsBackingOff($Disk) {
    $key = Get-AttemptKey $Disk
    if (-not $script:attempts.ContainsKey($key)) { return $false }
    $since = (Get-Date).AddSeconds(-$attemptWindowSeconds)
    $script:attempts[$key] = @($script:attempts[$key] | Where-Object { $_ -gt $since })
    return $script:attempts[$key].Count -ge $attemptsPerWindow
}

function Register-Attempt($Disk) {
    $key = Get-AttemptKey $Disk
    if (-not $script:attempts.ContainsKey($key)) { $script:attempts[$key] = @() }
    $script:attempts[$key] = @($script:attempts[$key]) + (Get-Date)
}

function Find-PassedDisk($State, $Disk) { return @($State.disks | Where-Object { Test-IsSameDisk $Disk $_ }) | Select-Object -First 1 }

function Add-PassedDisk($State, $Disk, [string]$Source) {
    if (Test-IsBackingOff $Disk) { return }
    Register-Attempt $Disk
    $passed = New-PassedDisk $Disk $Source
    try { Set-DiskOffline $Disk } catch { Add-Problem $State "disk $($Disk.Number): Windows did not set it offline: $_"; return }
    $result = Mount-WslDisk (Get-PhysicalDrivePath $Disk.Number)
    if ($result.ExitCode -ne 0) {
        Add-Problem $State "disk $($Disk.Number): wsl --mount failed: $($result.Output)"
        if ($passed.wasOnline) { try { Set-DiskOnline $Disk.Number } catch { Write-WatcherLog "disk $($Disk.Number): could not set it online again: $_" } }
        return
    }
    $State.disks = @($State.disks) + $passed
    $script:publishIsDue = $true
    Write-WatcherLog "disk $($Disk.Number) ($($passed.model), $Source) passed through to WSL"
}

function Remove-PassedDisk($State, $Passed, [switch]$RestoreOnline) {
    $result = Dismount-WslDisk (Get-PhysicalDrivePath $Passed.number)
    if ($result.ExitCode -ne 0) { Write-WatcherLog "disk $($Passed.number): wsl --unmount said: $($result.Output)" }
    if ($RestoreOnline -and $Passed.wasOnline) {
        try { Set-DiskOnline $Passed.number } catch { Add-Problem $State "disk $($Passed.number): could not set it online again: $_" }
    }
    $State.disks = @($State.disks | Where-Object { $_ -ne $Passed })
    $script:publishIsDue = $true
    Write-WatcherLog "disk $($Passed.number) ($($Passed.model)) released from WSL"
}

function Remove-VanishedDisks($State, [object[]]$Disks) {
    foreach ($passed in @($State.disks)) {
        if (@($Disks | Where-Object { Test-IsSameDisk $_ $passed }).Count -gt 0) { continue }
        Write-WatcherLog "disk $($passed.number) ($($passed.model)) is gone from Windows"
        Remove-PassedDisk $State $passed
    }
}

function Test-IsReleased($Request, $Disk) {
    $guid = ConvertTo-PartitionTableId "$($Disk.Guid)"
    return [bool]($guid -and @($Request.release) -contains $guid)
}

function Add-ArrayDisks($State, [object[]]$Disks, $Request) {
    foreach ($disk in $Disks) {
        if (Find-PassedDisk $State $disk) { continue }
        if (Test-IsReleased $Request $disk) { continue }
        if (-not (Test-IsArrayDisk $disk (Get-DiskPartitions $disk))) { continue }
        Add-PassedDisk $State $disk "rule"
    }
}

function Add-RequestedDisks($State, [object[]]$Disks, $Request) {
    foreach ($wanted in @($Request.attach)) {
        $disk = @($Disks | Where-Object { Test-IsSameDisk $_ $wanted }) | Select-Object -First 1
        if (-not $disk) { Add-Problem $State "disk $($wanted.Number) is no longer the disk that was confirmed; nothing passed through"; continue }
        if (Find-PassedDisk $State $disk) { continue }
        if (-not (Test-MayPassThroughOnRequest $disk (Get-DiskPartitions $disk))) {
            Add-Problem $State "disk $($disk.Number) refused: only a blank USB disk or one with only Linux filesystem partitions is passed through"
            continue
        }
        Add-PassedDisk $State $disk "attach"
    }
}

function Remove-ReleasedDisks($State, $Request) {
    foreach ($passed in @($State.disks)) {
        if ($passed.source -eq "rule" -and $passed.guid -and @($Request.release) -contains $passed.guid) {
            Remove-PassedDisk $State $passed -RestoreOnline
        }
    }
}

<#
.NOTES
Windows keeps showing a passed blank drive as RAW after the VM formats it, until Update-Disk makes it
read the drive again.
#>
function Update-BlankPassedDisks($State) {
    foreach ($passed in @($State.disks | Where-Object { -not $_.guid })) {
        Update-Disk -Number $passed.number -ErrorAction SilentlyContinue
    }
}

<#
.NOTES
A blank drive is passed through without a GPT id and gets one when it is formatted in the VM; the
mounter and the dashboard match SMART reports to drives by that id.
#>
function Update-PartitionTableIds($State, [object[]]$Disks) {
    foreach ($passed in @($State.disks)) {
        $disk = @($Disks | Where-Object { Test-IsSameDisk $_ $passed }) | Select-Object -First 1
        if (-not $disk) { continue }
        $guid = (Get-DiskIdentity $disk).Guid
        if ($guid -and $guid -ne $passed.guid) {
            $passed.guid = $guid
            $script:publishIsDue = $true
        }
    }
}

function Remove-AllDisks($State) { foreach ($passed in @($State.disks)) { Remove-PassedDisk $State $passed } }

function Get-SmartctlPath {
    $command = Get-Command smartctl.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $installed = Join-Path $env:ProgramFiles "smartmontools\bin\smartctl.exe"
    if (Test-Path $installed) { return $installed }
    return $null
}

function Invoke-Smartctl([string]$Path, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { return (@(& $Path @Arguments 2> $null) -join "`n") } catch { return "" } finally { $ErrorActionPreference = $previous }
}

<#
.NOTES
-n standby leaves a sleeping drive asleep, and its last report stands until it answers. The NVMe
bridges answer -d auto, the SATA bridges only -d sat.
#>
function Read-SmartReport([string]$Smartctl, [int]$Number) {
    foreach ($type in @("auto", "sat")) {
        $text = Invoke-Smartctl $Smartctl @("-j", "-n", "standby", "-i", "-H", "-A", "-d", $type, "/dev/pd$Number")
        if (-not $text) { continue }
        try { $report = $text | ConvertFrom-Json } catch { continue }
        if ($report -and $report.PSObject.Properties["smart_status"]) { return $report }
    }
    return $null
}

function Test-IsSmartDue($Passed) {
    if (-not $Passed.smartTriedAt) { return $true }
    return ((Get-Date) - [datetime]$Passed.smartTriedAt).TotalSeconds -ge $smartIntervalSeconds
}

function Update-SmartReports($State) {
    $smartctl = Get-SmartctlPath
    if (-not $smartctl) { return }
    foreach ($passed in @($State.disks | Where-Object { Test-IsSmartDue $_ })) {
        $passed.smartTriedAt = (Get-Date).ToString("o")
        $report = Read-SmartReport $smartctl $passed.number
        if (-not $report) { continue }
        $passed.smart = $report
        $passed.smartCheckedAt = (Get-Date).ToString("o")
        $script:publishIsDue = $true
    }
}

function Get-UnixSeconds { return [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) }

<#
.NOTES
The mounter and the dashboard read this as /status/wsl-disks.json and ignore it once it is 30 minutes
old, so it is written at least every 10 minutes while drives are passed through.
#>
function Get-PublishedDisks($State) {
    return [pscustomobject]@{
        updatedEpoch = Get-UnixSeconds
        disks        = @($State.disks | ForEach-Object {
            [pscustomobject]@{
                number = $_.number; ptuuid = $_.guid; size = $_.size; model = $_.model; serial = $_.serial
                source = $_.source; smartCheckedAt = $_.smartCheckedAt; smart = $_.smart
            }
        })
    }
}

function Get-StatusVolume {
    $result = Invoke-NativeCommand "docker" @("volume", "ls", "-q", "--filter", "label=com.docker.compose.project=$script:projectName", "--filter", "label=com.docker.compose.volume=storage-status")
    if ($result.ExitCode -ne 0) { return $null }
    return @($result.Output -split "`n" | Where-Object { $_ })[0]
}

<#
.NOTES
Windows PowerShell 5.1 starts what it pipes into a native command with a byte order mark, which
JSON.parse refuses, so sed takes it off.
#>
function Publish-WslDisks($State, [string]$Volume) {
    $json = ConvertTo-Json -InputObject (Get-PublishedDisks $State) -Depth 30 -Compress
    $write = "sed '1s/^\xEF\xBB\xBF//' > /status/wsl-disks.json.partial && mv /status/wsl-disks.json.partial /status/wsl-disks.json"
    $result = Invoke-NativeCommand "docker" @("run", "--rm", "-i", "-v", "${Volume}:/status", $probeImage, "sh", "-c", $write) $json
    if ($result.ExitCode -ne 0) { Write-WatcherLog "could not write wsl-disks.json: $($result.Output)" }
    return $result.ExitCode -eq 0
}

function Update-PublishedDisks($State) {
    $isDue = $script:publishIsDue -or (@($State.disks).Count -gt 0 -and ((Get-Date) - $script:lastPublished).TotalSeconds -ge $publishIntervalSeconds)
    if (-not $isDue) { return }
    $volume = Get-StatusVolume
    if (-not $volume) { return }
    if (Publish-WslDisks $State $volume) {
        $script:publishIsDue = $false
        $script:lastPublished = Get-Date
    }
}

function Clear-DisksAfterVmRestart($State, [string]$BootId) {
    if ($BootId -and $State.vmBootId -and $BootId -ne $State.vmBootId -and @($State.disks).Count -gt 0) {
        Write-WatcherLog "Docker Desktop's VM restarted; passing the drives through again"
        $State.disks = @()
        $script:publishIsDue = $true
    }
    if ($BootId) { $State.vmBootId = $BootId }
}

<#
.NOTES
An empty answer from Get-Disk would read as every passed drive vanishing at once, so a list without
the system disk is refused.
#>
function Get-WindowsDisks {
    $disks = @(Get-Disk -ErrorAction Stop)
    if (@($disks | Where-Object { Test-IsWindowsSystemDisk $_ }).Count -eq 0) { throw "Get-Disk listed no system disk" }
    return $disks
}

<#
.NOTES
The request says what the CLI wants; the drives are passed through only while the stack also runs,
so a stack that crashed or was removed without `down` gives its drives back within one round.
#>
function Invoke-WatcherRound($State, [bool]$StackIsRunning = $true) {
    $State.problems = @()
    $request = Read-AttachRequest
    if ($request -and -not $StackIsRunning) { $request.active = $false }
    if ($request) {
        $bootId = Get-DockerVmBootId
        Clear-DisksAfterVmRestart $State $bootId
        Update-BlankPassedDisks $State
        $disks = @(Get-WindowsDisks)
        Remove-VanishedDisks $State $disks
        $isNewRequest = $request.id -ne $State.handledRequest
        if (-not $request.active) {
            Remove-AllDisks $State
            $State.handledRequest = $request.id
        } elseif ($bootId) {
            if ($isNewRequest) { Add-RequestedDisks $State $disks $request }
            Remove-ReleasedDisks $State $request
            Add-ArrayDisks $State $disks $request
            Update-PartitionTableIds $State $disks
            $State.handledRequest = $request.id
        }
        Update-SmartReports $State
        Update-PublishedDisks $State
        if ($isNewRequest -and $State.handledRequest -eq $request.id) { $State.requestProblems = @($State.problems) }
    }
    $State.heartbeat = (Get-Date).ToString("o")
    Write-JsonFile $script:stateFile $State
}
