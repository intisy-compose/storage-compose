# Pester 3.4 (shipped with Windows): which disks may be passed through to WSL. Touches no disk; the
# last block only lists this PC's own disks, read-only, to show none of them would be chosen.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\disks.ps1")
. (Join-Path $PSScriptRoot "fakes.ps1")

Describe "rule 2: a USB disk whose partitions are all Linux filesystem" {
    It "takes a USB GPT disk with one Linux filesystem partition" {
        Test-IsArrayDisk (New-FakeDisk -Number 41) @(New-FakePartition) | Should Be $true
    }
    It "takes one with several Linux filesystem partitions" {
        Test-IsArrayDisk (New-FakeDisk -Number 41) @((New-FakePartition -Number 1), (New-FakePartition -Number 2)) | Should Be $true
    }
    It "takes one Windows has set offline, when its partitions are listed" {
        Test-IsArrayDisk (New-FakeDisk -Number 41 -IsOffline $true) @(New-FakePartition) | Should Be $true
    }
    It "refuses a disk with a Windows volume beside the Linux partition" {
        Test-IsArrayDisk (New-FakeDisk -Number 41) @((New-FakePartition), (New-FakePartition -Number 2 -GptType $basicDataType)) | Should Be $false
    }
    It "refuses an NTFS disk such as the FireCuda before its migration" {
        Test-IsArrayDisk (New-FakeDisk -Number 41) @(New-FakePartition -GptType $basicDataType -DriveLetter "G") | Should Be $false
    }
    It "refuses a Linux partition that carries a drive letter" {
        Test-IsArrayDisk (New-FakeDisk -Number 41) @(New-FakePartition -DriveLetter "H") | Should Be $false
    }
    It "refuses a Microsoft reserved partition beside a Linux one" {
        Test-IsArrayDisk (New-FakeDisk -Number 41) @((New-FakePartition -GptType $microsoftReservedType), (New-FakePartition -Number 2)) | Should Be $false
    }
    It "refuses a blank disk" {
        Test-IsArrayDisk (New-FakeDisk -Number 41) @() | Should Be $false
    }
    It "refuses an MBR disk" {
        Test-IsArrayDisk (New-FakeDisk -Number 41 -PartitionStyle "MBR") @(New-FakePartition -GptType $null -MbrType "131") | Should Be $false
    }
    It "refuses a disk that is not on USB" {
        foreach ($bus in @("NVMe", "SATA", "SAS", "RAID", "File Backed Virtual")) {
            Test-IsArrayDisk (New-FakeDisk -Number 41 -BusType $bus) @(New-FakePartition) | Should Be $false
        }
    }
    It "refuses a USB disk Windows boots from" {
        Test-IsArrayDisk (New-FakeDisk -Number 41 -IsSystem $true) @(New-FakePartition) | Should Be $false
    }
}

Describe "a blank disk, which only attach passes through" {
    It "is a USB disk without partitions" {
        Test-IsBlankDisk (New-FakeDisk -Number 42 -PartitionStyle "RAW") @() | Should Be $true
    }
    It "is not one Windows has offline, whose partitions it may not list" {
        Test-IsBlankDisk (New-FakeDisk -Number 42 -IsOffline $true) @() | Should Be $false
    }
    It "is not a disk with any partition" {
        Test-IsBlankDisk (New-FakeDisk -Number 42) @(New-FakePartition) | Should Be $false
    }
    It "is not a system disk or one off USB" {
        Test-IsBlankDisk (New-FakeDisk -Number 42 -IsSystem $true -PartitionStyle "RAW") @() | Should Be $false
        Test-IsBlankDisk (New-FakeDisk -Number 42 -BusType "SATA" -PartitionStyle "RAW") @() | Should Be $false
    }
    It "may be passed through on request, and so may an array disk, but never a Windows volume" {
        Test-MayPassThroughOnRequest (New-FakeDisk -Number 42 -PartitionStyle "RAW") @() | Should Be $true
        Test-MayPassThroughOnRequest (New-FakeDisk -Number 42) @(New-FakePartition) | Should Be $true
        Test-MayPassThroughOnRequest (New-FakeDisk -Number 42) @(New-FakePartition -GptType $basicDataType -DriveLetter "G") | Should Be $false
    }
}

Describe "disk identity" {
    $disk = New-FakeDisk -Number 43 -Guid "{11111111-2222-4333-8444-555555555555}"
    $identity = Get-DiskIdentity $disk
    It "carries the GPT id as Linux shows it, PTUUID" {
        $identity.Guid | Should BeExactly "11111111-2222-4333-8444-555555555555"
        ConvertTo-PartitionTableId "" | Should Be $null
    }
    It "stays the same disk when the VM gives it a GPT id" {
        Test-IsSameDisk (New-FakeDisk -Number 43 -Guid "{99999999-2222-4333-8444-555555555555}") $identity | Should Be $true
    }
    It "is another disk under another number or size" {
        Test-IsSameDisk (New-FakeDisk -Number 44 -Guid $disk.Guid) $identity | Should Be $false
        Test-IsSameDisk (New-FakeDisk -Number 43 -Guid $disk.Guid -Size 1000204886016) $identity | Should Be $false
    }
    It "is the same disk under another unique id while its GPT id matches" {
        Test-IsSameDisk (New-FakeDisk -Number 43 -Guid $disk.Guid -UniqueId "other") $identity | Should Be $true
    }
    It "is another disk under another unique id when it has no GPT id" {
        $blank = Get-DiskIdentity (New-FakeDisk -Number 43)
        Test-IsSameDisk (New-FakeDisk -Number 43 -UniqueId "other") $blank | Should Be $false
    }
    It "survives the trip through a request file" {
        $path = Join-Path ([System.IO.Path]::GetTempPath()) "attach-identity-$([guid]::NewGuid()).json"
        Write-JsonFile $path ([pscustomobject]@{ attach = @($identity) })
        $read = Read-JsonFile $path
        Remove-Item $path
        Test-IsSameDisk $disk @($read.attach)[0] | Should Be $true
    }
}

Describe "two drives behind one bridge, which share a serial and a unique id" {
    $first = New-FakeDisk -Number 3 -Guid "{fad2958e-1eea-41fe-a77e-8b7cdb39cda6}" -Size 1000204886016 -UniqueId "5000000000000001" -SerialNumber "920021404202"
    $second = New-FakeDisk -Number 4 -Guid "{ae97b07c-8b17-4464-b53c-8f683fcadaa2}" -Size 1000204886016 -UniqueId "5000000000000001" -SerialNumber "920021404202"
    It "are two disks" {
        Test-IsSameDisk $first (Get-DiskIdentity $second) | Should Be $false
        Test-IsSameDisk $second (Get-DiskIdentity $first) | Should Be $false
    }
    It "have two keys, taken from the GPT id and the size" {
        Get-DiskKey $first | Should Not Be (Get-DiskKey $second)
        Get-DiskKey $first | Should Be "gpt fad2958e-1eea-41fe-a77e-8b7cdb39cda6 1000204886016"
    }
    It "keep their keys when Windows numbers them anew" {
        $renumbered = New-FakeDisk -Number 9 -Guid $first.Guid -Size $first.Size -UniqueId $first.UniqueId
        Get-DiskKey $renumbered | Should Be (Get-DiskKey $first)
    }
    It "have two keys while blank, through their numbers" {
        $firstBlank = New-FakeDisk -Number 3 -Size 1000204886016 -UniqueId "5000000000000001"
        $secondBlank = New-FakeDisk -Number 4 -Size 1000204886016 -UniqueId "5000000000000001"
        Get-DiskKey $firstBlank | Should Not Be (Get-DiskKey $secondBlank)
    }
}

Describe "the shared files" {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) "attach-file-$([guid]::NewGuid()).json"
    It "replaces a file in place and keeps a one-element list a list" {
        Write-JsonFile $path ([pscustomobject]@{ id = "first"; release = @() })
        Write-JsonFile $path ([pscustomobject]@{ id = "second"; release = @("abc") })
        $text = Get-Content -Raw $path
        $text | Should Match '"release":\s*\[\s*"abc"\s*\]'
        (Read-JsonFile $path).id | Should Be "second"
        Test-Path "$path.partial" | Should Be $false
    }
    It "reads a broken or missing file as nothing" {
        Set-Content -Path $path -Value "{ not json"
        Read-JsonFile $path | Should Be $null
        Remove-Item $path
        Read-JsonFile $path | Should Be $null
    }
}

Describe "this PC's own disks (listed read-only)" {
    $ownDisks = @(Get-Disk)
    It "lists at least the system disk" {
        @($ownDisks | Where-Object { Test-IsWindowsSystemDisk $_ }).Count | Should BeGreaterThan 0
    }
    foreach ($disk in $ownDisks) {
        It "never passes through disk $($disk.Number) ($($disk.FriendlyName), $($disk.BusType))" {
            $partitions = Get-DiskPartitions $disk
            if ($disk.BusType -ne "USB") { Test-MayPassThroughOnRequest $disk $partitions | Should Be $false }
            if (@($partitions | Where-Object { Test-HasDriveLetter $_ }).Count -gt 0) { Test-MayPassThroughOnRequest $disk $partitions | Should Be $false }
        }
    }
    It "chooses none of them by rule 2" {
        @(Get-ArrayDisks | Where-Object { $_.BusType -ne "USB" -or (Test-IsWindowsSystemDisk $_) }).Count | Should Be 0
    }
}
