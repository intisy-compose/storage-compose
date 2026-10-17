# Fake Get-Disk and Get-Partition objects for the attach tests. Disk numbers start at 40, so even a
# fake that failed to shadow a real cmdlet would name a disk this PC does not have.

$linuxType = "{0fc63daf-8483-4772-8e79-3d69d8477de4}"
$basicDataType = "{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}"
$microsoftReservedType = "{e3c9e316-0b5c-4db8-817d-f92df00215ae}"

function New-FakeDisk {
    param(
        [int]$Number, [string]$BusType = "USB", [string]$PartitionStyle = "GPT", [bool]$IsOffline = $false,
        [bool]$IsSystem = $false, [string]$Guid = "", [uint64]$Size = 8001563222016, [string]$UniqueId = ""
    )
    if (-not $UniqueId) { $UniqueId = "USBSTOR\DISK&VEN_TEST&PROD_DISK$Number" }
    return [pscustomobject]@{
        Number = $Number; FriendlyName = "Test Disk $Number"; SerialNumber = "SERIAL$Number"; BusType = $BusType
        PartitionStyle = $PartitionStyle; IsOffline = $IsOffline; IsBoot = $IsSystem; IsSystem = $IsSystem
        Guid = $Guid; Size = $Size; UniqueId = $UniqueId
    }
}

function New-FakePartition {
    param([int]$Number = 1, [string]$GptType = $linuxType, [char]$DriveLetter = [char]0, [uint64]$Size = 8000000000000, [string]$MbrType = "")
    return [pscustomobject]@{ PartitionNumber = $Number; GptType = $GptType; DriveLetter = $DriveLetter; Size = $Size; MbrType = $MbrType }
}

function New-SystemDisk { return New-FakeDisk -Number 40 -BusType "NVMe" -IsSystem $true -Guid "{a3bbb9ce-8f9d-4b91-b088-81123211ca2e}" }
