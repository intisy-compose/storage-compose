# Which Windows disks may be passed through to WSL, and the files the CLI and the host agent share.
# Dot-sourced by docker-compose.ps1 and by the agent; defines functions only.

$linuxFilesystemPartitionType = "{0fc63daf-8483-4772-8e79-3d69d8477de4}"
$legacyAttachTaskName = "storage-compose WSL attach"
$attachRequestFileName = "attach-request.json"
$attachStateFileName = "attach-state.json"
$attachLogFileName = "host-agent\agent.log"

function Test-IsWindowsSystemDisk($Disk) { return [bool]($Disk.IsBoot -or $Disk.IsSystem) }

function Test-IsUsbDataDisk($Disk) { return $Disk.BusType -eq "USB" -and -not (Test-IsWindowsSystemDisk $Disk) }

function Test-HasDriveLetter($Partition) { return [bool]("$($Partition.DriveLetter)".Trim([char]0).Trim()) }

function Test-IsLinuxFilesystemPartition($Partition) {
    return "$($Partition.GptType)".ToLower() -eq $linuxFilesystemPartitionType -and -not (Test-HasDriveLetter $Partition)
}

<#
.NOTES
Rule 2 of docs specs/2026-10-11-wsl-passthrough.md: a USB disk whose partitions are all of the GPT type
"Linux filesystem", which is what the stack's format writes. No serials, because the D8's bridges report
one bridge serial for two drives. A disk whose partitions Windows cannot read reports none and is refused.
#>
function Test-IsArrayDisk($Disk, [object[]]$Partitions) {
    if (-not (Test-IsUsbDataDisk $Disk)) { return $false }
    if ($Disk.PartitionStyle -ne "GPT") { return $false }
    $all = @($Partitions | Where-Object { $_ })
    if ($all.Count -eq 0) { return $false }
    return @($all | Where-Object { -not (Test-IsLinuxFilesystemPartition $_) }).Count -eq 0
}

<#
.NOTES
Only an online disk counts as blank: Windows may list no partitions for an offline disk that has some.
#>
function Test-IsBlankDisk($Disk, [object[]]$Partitions) {
    return (Test-IsUsbDataDisk $Disk) -and -not $Disk.IsOffline -and @($Partitions | Where-Object { $_ }).Count -eq 0
}

function Test-MayPassThroughOnRequest($Disk, [object[]]$Partitions) {
    return (Test-IsArrayDisk $Disk $Partitions) -or (Test-IsBlankDisk $Disk $Partitions)
}

function Get-DiskPartitions($Disk) { return @(Get-Partition -DiskNumber $Disk.Number -ErrorAction SilentlyContinue) }

function Get-ArrayDisks { return @(Get-Disk | Where-Object { Test-IsArrayDisk $_ (Get-DiskPartitions $_) }) }

function ConvertTo-PartitionTableId([string]$Guid) {
    $id = $Guid.Trim("{}").ToLower()
    if ($id) { return $id }
    return $null
}

<#
.NOTES
Disk numbers move when a drive is plugged in again, so a request names the disk the human partner
confirmed, not only its number. The GPT id is not part of the identity: a blank drive gets one when the
dashboard formats it inside the VM, and that must not read as a different disk.
#>
function Get-DiskIdentity($Disk) {
    return [pscustomobject]@{
        Number   = [int]$Disk.Number
        UniqueId = "$($Disk.UniqueId)"
        Size     = [uint64]$Disk.Size
        Guid     = ConvertTo-PartitionTableId "$($Disk.Guid)"
    }
}

function Test-IsSameDisk($Disk, $Identity) {
    $current = Get-DiskIdentity $Disk
    return $current.Number -eq [int]$Identity.Number -and $current.UniqueId -eq "$($Identity.UniqueId)" -and $current.Size -eq [uint64]$Identity.Size
}

function Format-Size([uint64]$Bytes) {
    if ($Bytes -ge 1TB) { return "{0:N1} TB" -f ($Bytes / 1TB) }
    return "{0:N1} GB" -f ($Bytes / 1GB)
}

function Format-PartitionDescription($Partition) {
    $kind = "type $($Partition.GptType)"
    if ("$($Partition.GptType)".ToLower() -eq $linuxFilesystemPartitionType) { $kind = "Linux filesystem" }
    if (-not $Partition.GptType) { $kind = "MBR type $($Partition.MbrType)" }
    $letter = ""
    if (Test-HasDriveLetter $Partition) { $letter = ", drive $($Partition.DriveLetter):" }
    return "partition $($Partition.PartitionNumber): $(Format-Size $Partition.Size), $kind$letter"
}

function Format-DiskDescription($Disk, [object[]]$Partitions) {
    $lines = @("disk $($Disk.Number): $($Disk.FriendlyName), $(Format-Size $Disk.Size), $($Disk.BusType), $($Disk.PartitionStyle), serial $("$($Disk.SerialNumber)".Trim())")
    $all = @($Partitions | Where-Object { $_ })
    if ($all.Count -eq 0) { $lines += "  no partitions" }
    foreach ($partition in $all) { $lines += "  $(Format-PartitionDescription $partition)" }
    return $lines
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try { return (Get-Content -Raw -Path $Path -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}

<#
.NOTES
Written beside and swapped in with File.Replace, which never leaves the file missing (Move-Item -Force
deletes first, and a missing request reads as "not active"). The swap is retried while the other side
has the file open.
#>
function Write-JsonFile([string]$Path, $Value) {
    $partial = "$Path.partial"
    [System.IO.File]::WriteAllText($partial, (ConvertTo-Json -InputObject $Value -Depth 30))
    if (-not (Test-Path $Path)) { [System.IO.File]::Move($partial, $Path); return }
    for ($attempt = 1; ; $attempt++) {
        try { [System.IO.File]::Replace($partial, $Path, [NullString]::Value); return }
        catch { if ($attempt -ge 20) { throw }; Start-Sleep -Milliseconds 100 }
    }
}
