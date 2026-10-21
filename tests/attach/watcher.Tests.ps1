# Pester 3.4: the attach watcher's rounds, against fake disks, a fake wsl.exe and a fake Set-Disk.
# Nothing here reaches Windows' disks or WSL: every command that could is shadowed by a fake below,
# and the first test proves the shadowing holds.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\passthrough.ps1")
. (Join-Path $PSScriptRoot "fakes.ps1")

$global:fakeDisks = @()
$global:fakePartitions = @{}
$global:wslCalls = @()
$global:setDiskCalls = @()
$global:updateDiskCalls = @()
$global:bootId = "boot-1"
$global:dockerRuns = $true
$global:mountAnswers = @()
$global:published = @()

function Get-Disk { return $global:fakeDisks }
function Get-DiskPartitions($Disk) { return $global:fakePartitions[[int]$Disk.Number] }
function Update-Disk([int]$Number) { $global:updateDiskCalls += $Number }
function Set-Disk([int]$Number, [bool]$IsOffline) {
    $global:setDiskCalls += "$Number offline=$IsOffline"
    foreach ($disk in $global:fakeDisks) { if ($disk.Number -eq $Number) { $disk.IsOffline = $IsOffline } }
}
function Invoke-Wsl([string[]]$Arguments) {
    $line = $Arguments -join " "
    $global:wslCalls += $line
    if ($Arguments[0] -eq "--list") {
        $running = "Ubuntu"
        if ($global:dockerRuns) { $running = "Ubuntu`ndocker-desktop" }
        return [pscustomobject]@{ Output = $running; ExitCode = 0 }
    }
    if ($Arguments[0] -eq "-d") { return [pscustomobject]@{ Output = $global:bootId; ExitCode = 0 } }
    if ($Arguments[0] -eq "--mount" -and $global:mountAnswers.Count -gt 0) {
        $answer = $global:mountAnswers[0]
        $global:mountAnswers = @($global:mountAnswers | Select-Object -Skip 1)
        return $answer
    }
    return [pscustomobject]@{ Output = "The operation completed successfully."; ExitCode = 0 }
}
function Get-SmartctlPath { return "fake-smartctl" }
function Read-SmartReport([string]$Smartctl, [int]$Number) {
    return [pscustomobject]@{ serial_number = "SERIAL$Number"; smart_status = [pscustomobject]@{ passed = $true } }
}
function Get-StatusVolume { return "storage-compose_storage-status" }
function Publish-WslDisks($State, [string]$Volume) { $global:published += , (Get-PublishedDisks $State); return $true }

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "attach-watcher-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $scratch | Out-Null
$requestFile = Join-Path $scratch "attach-request.json"
$stateFile = Join-Path $scratch "attach-state.json"
$logFile = Join-Path $scratch "attach.log"

function Reset-World([object[]]$Disks, [hashtable]$Partitions) {
    $global:fakeDisks = @($Disks)
    $global:fakePartitions = $Partitions
    $global:wslCalls = @()
    $global:setDiskCalls = @()
    $global:bootId = "boot-1"
    $global:dockerRuns = $true
    $global:mountAnswers = @()
    $global:published = @()
    $script:attempts = @{}
    $script:publishIsDue = $true
    Remove-Item -Force -ErrorAction SilentlyContinue $requestFile, $stateFile
}

function Send-Request([bool]$Active, [object[]]$Attach = @(), [string[]]$Release = @()) {
    $id = [guid]::NewGuid().ToString()
    Write-JsonFile $requestFile ([pscustomobject]@{ id = $id; active = $Active; attach = @($Attach); release = @($Release) })
    return $id
}

function Get-MountCalls { return @($global:wslCalls | Where-Object { $_ -like "--mount*" }) }
function Get-UnmountCalls { return @($global:wslCalls | Where-Object { $_ -like "--unmount*" }) }

$arrayGuid = "{11111111-2222-4333-8444-555555555555}"
function New-StandardWorld {
    $disks = @(
        (New-SystemDisk),
        (New-FakeDisk -Number 41 -Guid $arrayGuid),
        (New-FakeDisk -Number 42 -Guid "{22222222-2222-4333-8444-555555555555}"),
        (New-FakeDisk -Number 43 -PartitionStyle "RAW"),
        (New-FakeDisk -Number 44 -BusType "SATA" -Guid "{44444444-2222-4333-8444-555555555555}")
    )
    $partitions = @{
        40 = @(New-FakePartition -GptType $basicDataType -DriveLetter "C")
        41 = @(New-FakePartition)
        42 = @(New-FakePartition -GptType $basicDataType -DriveLetter "G")
        43 = @()
        44 = @(New-FakePartition)
    }
    Reset-World $disks $partitions
}

Describe "the fakes" {
    It "shadow every command that could reach a disk or WSL" {
        foreach ($name in @("Get-Disk", "Set-Disk", "Update-Disk", "Get-DiskPartitions", "Invoke-Wsl", "Read-SmartReport", "Publish-WslDisks")) {
            (Get-Command $name).CommandType | Should Be "Function"
        }
        (Get-Command Get-Disk).ScriptBlock.ToString() | Should Match "fakeDisks"
        (Get-Command Set-Disk).ScriptBlock.ToString() | Should Match "setDiskCalls"
        (Get-Command Invoke-Wsl).ScriptBlock.ToString() | Should Match "wslCalls"
    }
}

Describe "up: a round with an active request" {
    New-StandardWorld
    $state = New-WatcherState $null
    $id = Send-Request -Active $true
    Invoke-WatcherRound $state

    It "passes through only the USB disk with Linux filesystem partitions" {
        @($state.disks).Count | Should Be 1
        $state.disks[0].number | Should Be 41
        $state.disks[0].source | Should Be "rule"
        $state.disks[0].guid | Should Be "11111111-2222-4333-8444-555555555555"
    }
    It "sets it offline first and mounts it bare" {
        $global:setDiskCalls | Should Be @("41 offline=True")
        Get-MountCalls | Should Be @("--mount \\.\PHYSICALDRIVE41 --bare")
    }
    It "touches neither the NTFS disk, the blank disk, the SATA disk nor the system disk" {
        @($global:wslCalls | Where-Object { $_ -match "PHYSICALDRIVE4[02-4]" }).Count | Should Be 0
        @($global:setDiskCalls | Where-Object { $_ -notmatch "^41 " }).Count | Should Be 0
    }
    It "acknowledges the request, reads SMART and publishes it" {
        $state.handledRequest | Should Be $id
        $state.disks[0].smart.serial_number | Should Be "SERIAL41"
        @($global:published).Count | Should Be 1
        $published = $global:published[0]
        @($published.disks).Count | Should Be 1
        $published.disks[0].ptuuid | Should Be "11111111-2222-4333-8444-555555555555"
        $published.disks[0].size | Should Be 8001563222016
    }
    It "writes a state file the CLI can read" {
        $saved = Read-JsonFile $stateFile
        $saved.handledRequest | Should Be $id
        @($saved.disks)[0].number | Should Be 41
        (Get-Content -Raw $stateFile) | Should Match '"disks":\s*\['
    }
    It "does nothing more in the next round" {
        $global:wslCalls = @(); $global:setDiskCalls = @()
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
        @($global:setDiskCalls).Count | Should Be 0
        @($state.disks).Count | Should Be 1
    }
}

Describe "a drive that drops off USB and comes back" {
    New-StandardWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state
    $array = $global:fakeDisks | Where-Object { $_.Number -eq 41 }

    It "is released from WSL when Windows no longer lists it" {
        $global:fakeDisks = @($global:fakeDisks | Where-Object { $_.Number -ne 41 })
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @($state.disks).Count | Should Be 0
        Get-UnmountCalls | Should Be @("--unmount \\.\PHYSICALDRIVE41")
    }
    It "is passed through again when it is back, under a new number" {
        $back = New-FakeDisk -Number 45 -Guid $arrayGuid -UniqueId $array.UniqueId
        $global:fakeDisks = @($global:fakeDisks) + $back
        $global:fakePartitions[45] = @(New-FakePartition)
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @($state.disks).Count | Should Be 1
        $state.disks[0].number | Should Be 45
        Get-MountCalls | Should Be @("--mount \\.\PHYSICALDRIVE45 --bare")
    }
    It "is detached and attached again when WSL still lists it under the same number" {
        $global:fakeDisks = @($global:fakeDisks | Where-Object { $_.Number -ne 45 })
        Invoke-WatcherRound $state
        $global:fakeDisks = @($global:fakeDisks) + (New-FakeDisk -Number 45 -Guid $arrayGuid -UniqueId $array.UniqueId)
        $global:mountAnswers = @([pscustomobject]@{ Output = "Error code: Wsl/Service/AttachDisk/MountDisk/WSL_E_DISK_ALREADY_ATTACHED"; ExitCode = -1 })
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @($global:wslCalls | Where-Object { $_ -like "--mount*" -or $_ -like "--unmount*" }) | Should Be @("--mount \\.\PHYSICALDRIVE45 --bare", "--unmount \\.\PHYSICALDRIVE45", "--mount \\.\PHYSICALDRIVE45 --bare")
        @($state.disks).Count | Should Be 1
    }
}

Describe "a stack whose containers stopped without down" {
    New-StandardWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state

    It "gives the drives back although the request still says active" {
        $global:wslCalls = @()
        Invoke-WatcherRound $state $false
        @($state.disks).Count | Should Be 0
        Get-UnmountCalls | Should Be @("--unmount \\.\PHYSICALDRIVE41")
    }
    It "passes them through again once the stack runs" {
        $global:wslCalls = @()
        Invoke-WatcherRound $state $true
        @($state.disks).Count | Should Be 1
        Get-MountCalls | Should Be @("--mount \\.\PHYSICALDRIVE41 --bare")
    }
}

Describe "a Docker Desktop or WSL restart" {
    New-StandardWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state

    It "waits while Docker Desktop's distribution is not running, without starting it" {
        $global:dockerRuns = $false
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @($global:wslCalls | Where-Object { $_ -like "-d *" -or $_ -like "--mount*" }).Count | Should Be 0
        @($state.disks).Count | Should Be 1
    }
    It "passes the drives through again once the VM has a new boot id" {
        $global:dockerRuns = $true
        $global:bootId = "boot-2"
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        Get-MountCalls | Should Be @("--mount \\.\PHYSICALDRIVE41 --bare")
        @($state.disks).Count | Should Be 1
        $state.vmBootId | Should Be "boot-2"
    }
    It "carries over a watcher restart through its state file" {
        $reloaded = New-WatcherState (Read-JsonFile $stateFile)
        $global:wslCalls = @()
        Invoke-WatcherRound $reloaded
        @(Get-MountCalls).Count | Should Be 0
        @($reloaded.disks).Count | Should Be 1
    }
}

Describe "down" {
    New-StandardWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state
    $global:wslCalls = @(); $global:setDiskCalls = @(); $global:published = @()
    $id = Send-Request -Active $false
    Invoke-WatcherRound $state

    It "unmounts every passed drive and leaves it offline in Windows" {
        Get-UnmountCalls | Should Be @("--unmount \\.\PHYSICALDRIVE41")
        @($global:setDiskCalls).Count | Should Be 0
        @($state.disks).Count | Should Be 0
        $state.handledRequest | Should Be $id
    }
    It "publishes the empty list, so no stale SMART report is read later" {
        @($global:published).Count | Should Be 1
        @($global:published[0].disks).Count | Should Be 0
    }
    It "passes nothing through while inactive" {
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
    }
    It "is handled even while Docker Desktop is not running" {
        Send-Request -Active $true | Out-Null
        Invoke-WatcherRound $state
        $global:dockerRuns = $false
        $id = Send-Request -Active $false
        Invoke-WatcherRound $state
        $state.handledRequest | Should Be $id
        @($state.disks).Count | Should Be 0
    }
}

Describe "a disk the VM shows without an array label" {
    New-StandardWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state
    $global:wslCalls = @(); $global:setDiskCalls = @()
    Send-Request -Active $true -Release @("11111111-2222-4333-8444-555555555555") | Out-Null
    Invoke-WatcherRound $state

    It "is unmounted and set online again, as it was" {
        Get-UnmountCalls | Should Be @("--unmount \\.\PHYSICALDRIVE41")
        $global:setDiskCalls | Should Be @("41 offline=False")
        @($state.disks).Count | Should Be 0
    }
    It "stays with Windows in the next rounds" {
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
    }
}

Describe "attach <disk number>" {
    New-StandardWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state
    $blank = $global:fakeDisks | Where-Object { $_.Number -eq 43 }
    $ntfs = $global:fakeDisks | Where-Object { $_.Number -eq 42 }
    $system = $global:fakeDisks | Where-Object { $_.Number -eq 40 }

    It "passes the confirmed blank disk through" {
        $global:wslCalls = @()
        Send-Request -Active $true -Attach @(Get-DiskIdentity $blank) | Out-Null
        Invoke-WatcherRound $state
        Get-MountCalls | Should Be @("--mount \\.\PHYSICALDRIVE43 --bare")
        @($state.disks | Where-Object { $_.number -eq 43 })[0].source | Should Be "attach"
        @($state.requestProblems).Count | Should Be 0
    }
    It "refuses a Windows volume even when the request names it" {
        $global:wslCalls = @()
        Send-Request -Active $true -Attach @(Get-DiskIdentity $ntfs) | Out-Null
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
        $state.requestProblems[0] | Should Match "disk 42 refused"
    }
    It "refuses the system disk even when the request names it" {
        $global:wslCalls = @()
        Send-Request -Active $true -Attach @(Get-DiskIdentity $system) | Out-Null
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
        $state.requestProblems[0] | Should Match "disk 40 refused"
    }
    It "refuses a disk that is no longer the one confirmed" {
        $other = Get-DiskIdentity $blank
        $other.UniqueId = "another drive"
        $global:wslCalls = @()
        Send-Request -Active $true -Attach @($other) | Out-Null
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
        $state.requestProblems[0] | Should Match "no longer the disk that was confirmed"
    }
    It "asks Windows to read the passed blank disk again while it has no GPT id" {
        $global:updateDiskCalls = @()
        Invoke-WatcherRound $state
        $global:updateDiskCalls | Should Be @(43)
    }
    It "keeps the blank disk passed through once the dashboard formats it in the VM" {
        $blank.Guid = "{77777777-2222-4333-8444-555555555555}"
        $global:fakePartitions[43] = @(New-FakePartition)
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @(Get-UnmountCalls).Count | Should Be 0
        @($state.disks | Where-Object { $_.number -eq 43 }).Count | Should Be 1
    }
    It "publishes the partition table id the format gave the blank disk" {
        @($state.disks | Where-Object { $_.number -eq 43 })[0].guid | Should Be "77777777-2222-4333-8444-555555555555"
        @($global:published[-1].disks | Where-Object { $_.number -eq 43 })[0].ptuuid | Should Be "77777777-2222-4333-8444-555555555555"
    }
}

Describe "a drive that will not attach" {
    New-StandardWorld
    $state = New-WatcherState $null
    $failure = [pscustomobject]@{ Output = "Error code: Wsl/Service/AttachDisk/E_ACCESSDENIED"; ExitCode = -1 }
    $global:mountAnswers = @($failure, $failure, $failure, $failure, $failure)
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state

    It "is reported and set online again" {
        $state.problems[0] | Should Match "wsl --mount failed"
        $global:setDiskCalls | Should Be @("41 offline=True", "41 offline=False")
        @($state.disks).Count | Should Be 0
    }
    It "is left alone after three attempts in ten minutes" {
        Invoke-WatcherRound $state
        Invoke-WatcherRound $state
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
    }
}

function New-BridgeWorld {
    $d8Size = [uint64]1000204886016
    $bridgeId = "5000000000000001"
    $disks = @(
        (New-SystemDisk),
        (New-FakeDisk -Number 45 -Guid "{cf526c79-9766-47e9-8568-6bb978732023}" -Size $d8Size -UniqueId $bridgeId -SerialNumber "A00022304202"),
        (New-FakeDisk -Number 46 -Guid "{a99e47ea-bdd3-4083-841a-d7cc6c0f2c66}" -Size $d8Size -UniqueId $bridgeId -SerialNumber "A00022304202"),
        (New-FakeDisk -Number 44 -Guid "{ae97b07c-8b17-4464-b53c-8f683fcadaa2}" -Size $d8Size -UniqueId $bridgeId -SerialNumber "920021404202"),
        (New-FakeDisk -Number 43 -Guid "{fad2958e-1eea-41fe-a77e-8b7cdb39cda6}" -Size $d8Size -UniqueId $bridgeId -SerialNumber "920021404202")
    )
    $partitions = @{ 40 = @(New-FakePartition -GptType $basicDataType -DriveLetter "C") }
    foreach ($number in 43..46) { $partitions[$number] = @(New-FakePartition) }
    Reset-World $disks $partitions
}

Describe "the D8's drives, two behind each bridge with one serial and one unique id" {
    New-BridgeWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state

    It "passes all four through in one round" {
        (@($state.disks | ForEach-Object { $_.number } | Sort-Object) -join ",") | Should Be "43,44,45,46"
        @(Get-MountCalls).Count | Should Be 4
    }
    It "backs off only the drive that fails, not its bridge sibling" {
        New-BridgeWorld
        $state = New-WatcherState $null
        $failure = [pscustomobject]@{ Output = "Error code: Wsl/Service/AttachDisk/E_ACCESSDENIED"; ExitCode = -1 }
        $success = [pscustomobject]@{ Output = "The operation completed successfully."; ExitCode = 0 }
        $global:mountAnswers = @($failure, $success, $success, $success, $failure, $failure)
        Send-Request -Active $true | Out-Null
        Invoke-WatcherRound $state
        Invoke-WatcherRound $state
        Invoke-WatcherRound $state
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @(Get-MountCalls).Count | Should Be 0
        (@($state.disks | ForEach-Object { $_.number } | Sort-Object) -join ",") | Should Be "43,44,46"
    }
    It "keeps a drive whose serial changed and logs it as a warning" {
        New-BridgeWorld
        $state = New-WatcherState $null
        Send-Request -Active $true | Out-Null
        Invoke-WatcherRound $state
        ($global:fakeDisks | Where-Object { $_.Number -eq 43 }).SerialNumber = "OTHER"
        Remove-Item -Force -ErrorAction SilentlyContinue $logFile
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @(Get-UnmountCalls).Count | Should Be 0
        @($state.disks).Count | Should Be 4
        @($state.disks | Where-Object { $_.number -eq 43 })[0].serial | Should Be "OTHER"
        (Get-Content -Raw $logFile) | Should Match "warning: disk 43 reports the serial OTHER, not 920021404202"
        @($state.problems).Count | Should Be 0
    }
}

Describe "requests and disk lists it must not act on" {
    New-StandardWorld
    $state = New-WatcherState $null
    Send-Request -Active $true | Out-Null
    Invoke-WatcherRound $state

    It "keeps every drive while the request file cannot be read" {
        Set-Content -Path $requestFile -Value "{ half written"
        $global:wslCalls = @()
        Invoke-WatcherRound $state
        @(Get-UnmountCalls).Count | Should Be 0
        @($state.disks).Count | Should Be 1
    }
    It "keeps every drive when Get-Disk lists no system disk" {
        Send-Request -Active $true | Out-Null
        $global:fakeDisks = @()
        $global:wslCalls = @()
        { Invoke-WatcherRound $state } | Should Throw
        @(Get-UnmountCalls).Count | Should Be 0
        @($state.disks).Count | Should Be 1
    }
}

Remove-Item -Recurse -Force $scratch
Remove-Variable -Scope Global -Name fakeDisks, fakePartitions, wslCalls, setDiskCalls, updateDiskCalls, bootId, dockerRuns, mountAnswers, published
