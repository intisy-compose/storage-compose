# The layered sync's hand-off executor for the host agent's native nodes (plan call 3, the same rules as
# images/nodes/handoff.sh). It acts only on files the dashboard's contract names, only while the node's
# own node file says apply = true, and only on a file that is still the confirmed one on disk: it
# appends the path to the folder's .stignore-handoff, waits until Syncthing reports it ignored, then
# renames it into <root>\.storage\handoff-trash\<day>\<folder id>\. Nothing is deleted except what this
# moved into that trash, once it is $handoffTrashDays old. It never removes a .stignore-handoff line and
# never asks Syncthing to override, revert or delete anything. Dot-sourced by the agent; defines
# functions and values only.

$handoffTrashDays = 7
$handoffQuietMinutes = 10
$handoffContractMaxAgeSeconds = 300
$handoffContractMaxAheadSeconds = 60
$handoffIgnoreWaitSeconds = 20
$handoffRoundSeconds = 60
$handoffListName = ".stignore-handoff"
$lastHandoffRound = [datetime]::MinValue

if (-not ("StorageCompose.HandoffNative" -as [type])) {
    Add-Type -Namespace StorageCompose -Name HandoffNative -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
'@
}

function Get-HandoffNow { return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }

function Get-AgentHandoffFolder([string]$StackFolder) { return Join-Path (Get-AgentFolder $StackFolder) "handoff" }

function Get-UnixSeconds([datetime]$Utc) { return [int64][math]::Floor(($Utc - [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)).TotalSeconds) }

function Get-HandoffUri([string]$Value) { return [Uri]::EscapeDataString($Value) }

function Test-IsReparsePoint([string]$Path) {
    return ([System.IO.File]::GetAttributes($Path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
}

function Test-IsInsideFolder([string]$Folder, [string]$Path) {
    $prefix = $Folder.TrimEnd('\') + '\'
    return $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

<#
.NOTES
A path an ignore line can name exactly and that cannot leave its folder: `/` separated, no empty, . or
.. segment, and none of the characters Windows refuses in a name or Syncthing reads as a pattern.
#>
function Test-IsPlainHandoffPath([string]$Path) {
    if (-not $Path -or $Path.StartsWith("/") -or $Path.EndsWith("/")) { return $false }
    if ($Path -match '[\\:*?"<>|\[\]{}]' -or $Path -match '[\x00-\x1f]') { return $false }
    return @($Path -split '/' | Where-Object { $_ -in @("", ".", "..") }).Count -eq 0
}

<#
.NOTES
Every directory from the folder down to the file exists and is no junction or link, and the file is a
regular file, so the path is exactly where it says.
#>
function Test-IsPlainHandoffFile([string]$Folder, [string]$Relative) {
    $current = $Folder
    $segments = @($Relative -split '/')
    for ($index = 0; $index -lt $segments.Count - 1; $index++) {
        $current = Join-Path $current $segments[$index]
        if (-not [System.IO.Directory]::Exists($current) -or (Test-IsReparsePoint $current)) { return $false }
    }
    $file = Join-Path $current $segments[-1]
    return [System.IO.File]::Exists($file) -and -not (Test-IsReparsePoint $file)
}

function Get-HandoffBlockSize([int64]$Size, [int64]$Count) {
    if ($Size -eq 0) { if ($Count -eq 1) { return 131072 }; return $null }
    for ($blockSize = 131072; $blockSize -le 16777216; $blockSize *= 2) {
        if ([math]::Ceiling($Size / $blockSize) -eq $Count) { return $blockSize }
    }
    return $null
}

function Get-StreamBlocksHash([System.IO.Stream]$Stream, [int64]$BlockSize) {
    $blockHasher = [System.Security.Cryptography.SHA256]::Create()
    $outer = [System.Security.Cryptography.SHA256]::Create()
    try {
        $buffer = New-Object byte[] $BlockSize
        $hashes = New-Object System.IO.MemoryStream
        do {
            $filled = 0
            while ($filled -lt $BlockSize) {
                $read = $Stream.Read($buffer, $filled, $BlockSize - $filled)
                if ($read -le 0) { break }
                $filled += $read
            }
            if ($filled -gt 0 -or $hashes.Length -eq 0) {
                $digest = $blockHasher.ComputeHash($buffer, 0, $filled)
                $hashes.Write($digest, 0, $digest.Length)
            }
        } while ($filled -eq $BlockSize)
        return [Convert]::ToBase64String($outer.ComputeHash($hashes.ToArray()))
    } finally {
        $blockHasher.Dispose()
        $outer.Dispose()
    }
}

<#
.NOTES
Syncthing's blocksHash: base64 of SHA-256 over the SHA-256 of each block, the block size the one that
splits the file into the block count its index reports.
#>
function Get-HandoffBlocksHash([string]$Path, [int64]$Size, [int64]$Count) {
    $blockSize = Get-HandoffBlockSize $Size $Count
    if (-not $blockSize) { return $null }
    $stream = [System.IO.File]::Open($Path, "Open", "Read", "Read")
    try { return Get-StreamBlocksHash $stream $blockSize } finally { $stream.Dispose() }
}

<#
.NOTES
The file is opened with no sharing at all, so it is "open" whenever any other process has it, and the
hash is read through that same handle, so nothing can write to it meanwhile.
#>
function Get-HandoffDiskDifference([string]$Folder, $Entry) {
    if (-not (Test-IsPlainHandoffFile $Folder $Entry.path)) { return "it is not a regular file inside the folder" }
    $path = Join-Path $Folder ($Entry.path -replace '/', '\')
    $info = [System.IO.FileInfo]::new($path)
    if ($info.Length -ne [int64]$Entry.size) { return "its size is $($info.Length), not the confirmed $($Entry.size)" }
    $modified = Get-UnixSeconds $info.LastWriteTimeUtc
    if ($modified -ne [int64]$Entry.modifiedSeconds) { return "it was modified at $modified, not at the confirmed $($Entry.modifiedSeconds)" }
    if ((Get-HandoffNow) - $modified -lt $handoffQuietMinutes * 60) { return "it changed within the last $handoffQuietMinutes minutes" }
    try { $stream = [System.IO.File]::Open($path, "Open", "Read", "None") } catch { return "it is open" }
    try {
        $blockSize = Get-HandoffBlockSize $info.Length ([int64]$Entry.numBlocks)
        if (-not $blockSize) { return "its blocks cannot be hashed" }
        if ((Get-StreamBlocksHash $stream $blockSize) -cne $Entry.blocksHash) { return "its content is not the confirmed content" }
    } finally { $stream.Dispose() }
    return $null
}

function Get-HandoffFileReport($Instance, [string]$FolderId, [string]$Relative) {
    return Invoke-SyncthingApi $Instance "Get" "/rest/db/file?folder=$(Get-HandoffUri $FolderId)&file=$(Get-HandoffUri $Relative)"
}

function Test-SameVersion($Left, $Right) { return (@($Left) -join "|") -ceq (@($Right) -join "|") }

function Get-HandoffIndexDifference($Instance, [string]$FolderId, $Entry) {
    try { $report = Get-HandoffFileReport $Instance $FolderId $Entry.path } catch { return "its index entry cannot be read" }
    $local = $report.local
    if (-not $local) { return "it has no entry in the index" }
    if ($local.deleted -or $local.ignored -or $local.invalid) { return "its index entry is deleted, ignored or invalid" }
    if (-not (Test-SameVersion $local.version $Entry.version) -or [int64]$local.size -ne [int64]$Entry.size -or "$($local.blocksHash)" -cne $Entry.blocksHash) { return "its index entry is not the confirmed version" }
    if (-not (Test-SameVersion $report.global.version $Entry.version)) { return "the global version is not the confirmed one" }
    $held = @($report.availability | Where-Object { $_ -and $_.id -ceq $Entry.keeperDevice -and -not $_.fromTemporary })
    if ($held.Count -eq 0) { return "the keeper does not hold the confirmed version, as this node sees it" }
    return $null
}

function Test-ReportsIgnored($Instance, [string]$FolderId, [string]$Relative) {
    try { return [bool](Get-HandoffFileReport $Instance $FolderId $Relative).local.ignored } catch { return $false }
}

function Test-FileHasLine([string]$Path, [string]$Line) {
    if (-not [System.IO.File]::Exists($Path)) { return $false }
    return @([System.IO.File]::ReadAllLines($Path) | Where-Object { $_ -ceq $Line }).Count -gt 0
}

function Get-HandoffFolderDifference($Instance, [string]$FolderId, [string]$ContractPath, [string]$RootFull) {
    try { $config = Invoke-SyncthingApi $Instance "Get" "/rest/config/folders/$(Get-HandoffUri $FolderId)" } catch { return "the folder's config cannot be read" }
    if ($config.type -ne "sendonly") { return "the folder is $($config.type) here, not send-only" }
    $path = "$($config.path)".TrimEnd('\')
    if ($path -ne $ContractPath.TrimEnd('\')) { return "the folder is at $path here, not at the contract's $($ContractPath.TrimEnd('\'))" }
    if (-not [System.IO.Directory]::Exists($path)) { return "the folder's path does not exist" }
    $full = [System.IO.Path]::GetFullPath($path).TrimEnd('\')
    if ($full -ne $path -or -not (Test-IsInsideFolder $RootFull $full)) { return "the folder is not inside the node's root" }
    $relative = $full.Substring($RootFull.TrimEnd('\').Length).Trim('\')
    $current = $RootFull
    foreach ($segment in @($relative -split '\\')) {
        $current = Join-Path $current $segment
        if (Test-IsReparsePoint $current) { return "the folder's path goes through a link" }
    }
    $ignores = Join-Path $full ".stignore"
    if (-not (Test-FileHasLine $ignores "#include $handoffListName") -or -not (Test-FileHasLine $ignores "/$handoffListName")) { return "the folder's .stignore does not include the hand-off list yet" }
    $list = Join-Path $full $handoffListName
    if (-not [System.IO.File]::Exists($list) -or (Test-IsReparsePoint $list)) { return "the folder has no regular $handoffListName" }
    return $null
}

function New-HandoffResultLine([string]$FolderId, [string]$Relative, [string]$Outcome, [string]$Reason, [string]$Trash) {
    $line = [ordered]@{ folderId = $FolderId; path = $Relative; outcome = $Outcome; reason = $Reason }
    if ($Trash) { $line.trash = $Trash }
    if ($Outcome -ne "moved") { Write-WatcherLog "hand-off $FolderId/$Relative`: $Outcome`: $Reason" }
    return [pscustomobject]$line
}

<#
.NOTES
MoveFileEx without MOVEFILE_COPY_ALLOWED renames or fails: it never copies and deletes across volumes,
and without MOVEFILE_REPLACE_EXISTING it never overwrites a file in the trash.
#>
function Move-HandoffFile([string]$Source, [string]$Target) {
    return [StorageCompose.HandoffNative]::MoveFileEx($Source, $Target, 0)
}

function Move-ToHandoffTrash([string]$TrashRoot, [string]$FolderId, [string]$Folder, $Entry) {
    $day = [DateTimeOffset]::FromUnixTimeSeconds((Get-HandoffNow)).UtcDateTime.ToString("yyyy-MM-dd")
    $relative = "$day/$FolderId/$($Entry.path)"
    $source = Join-Path $Folder ($Entry.path -replace '/', '\')
    $target = Join-Path $TrashRoot ($relative -replace '/', '\')
    if ([System.IO.File]::Exists($target) -or [System.IO.Directory]::Exists($target)) { return @{ problem = "a file of that name is in the trash already" } }
    try { New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null } catch { return @{ problem = "the trash folder cannot be made" } }
    if (-not (Move-HandoffFile $source $target)) { return @{ problem = "it could not be renamed into the trash" } }
    $moved = [System.IO.FileInfo]::new($target)
    if ($moved.Length -ne [int64]$Entry.size -or (Get-UnixSeconds $moved.LastWriteTimeUtc) -ne [int64]$Entry.modifiedSeconds) {
        Move-HandoffFile $target $source | Out-Null
        return @{ problem = "it changed while it was moved, so it was put back" }
    }
    $record = [ordered]@{ movedAt = (Get-HandoffNow); trash = $relative; folderId = $FolderId; path = $Entry.path; size = [int64]$Entry.size; modifiedSeconds = [int64]$Entry.modifiedSeconds; blocksHash = $Entry.blocksHash; keeper = $Entry.keeper }
    [System.IO.File]::AppendAllText((Join-Path $TrashRoot "manifest.jsonl"), "$(ConvertTo-Json -InputObject $record -Compress)`n")
    return @{ trash = $relative }
}

function Add-HandoffLines([string]$List, [object[]]$Entries) {
    $encoding = [System.Text.UTF8Encoding]::new($false)
    foreach ($entry in $Entries) {
        if (-not (Test-FileHasLine $List "/$($entry.path)")) { [System.IO.File]::AppendAllText($List, "/$($entry.path)`n", $encoding) }
    }
}

<#
.NOTES
One folder's entries: each checked against its index and its disk, the passing ones ignored together
with one rescan of just their paths, then each checked again and moved. A failure leaves that path as
it is and the others go on.
#>
function Invoke-FolderHandoff($Instance, [string]$FolderId, [object[]]$Entries, [string]$RootFull, [string]$TrashRoot, [datetime]$Deadline) {
    $results = @()
    $folder = "$($Entries[0].folderPath)".TrimEnd('\')
    $problem = Get-HandoffFolderDifference $Instance $FolderId $folder $RootFull
    if ($problem) { return @($Entries | ForEach-Object { New-HandoffResultLine $FolderId $_.path "refused" $problem }) }
    $passed = @()
    foreach ($entry in $Entries) {
        if (-not (Test-IsPlainHandoffPath $entry.path) -or $entry.type -ne "FILE_INFO_TYPE_FILE") { $results += New-HandoffResultLine $FolderId $entry.path "refused" "the path is not a plain file path inside the folder"; continue }
        if (-not (Test-IsPlainHandoffFile $folder $entry.path)) { $results += New-HandoffResultLine $FolderId $entry.path "refused" "it is not a regular file inside the folder, or a link is on its way"; continue }
        $problem = Get-HandoffIndexDifference $Instance $FolderId $entry
        if (-not $problem) { $problem = Get-HandoffDiskDifference $folder $entry }
        if ($problem) { $results += New-HandoffResultLine $FolderId $entry.path "refused" $problem; continue }
        $passed += $entry
    }
    if ($passed.Count -eq 0) { return $results }
    Add-HandoffLines (Join-Path $folder $handoffListName) $passed
    $subs = ($passed | ForEach-Object { "&sub=$(Get-HandoffUri $_.path)" }) -join ""
    try { Invoke-SyncthingApi $Instance "Post" "/rest/db/scan?folder=$(Get-HandoffUri $FolderId)$subs" | Out-Null } catch { Write-WatcherLog "hand-off $FolderId`: the rescan was not accepted; waiting for Syncthing's own" }
    $waiting = $passed
    while ($waiting.Count -gt 0) {
        $still = @()
        foreach ($entry in $waiting) {
            if (-not (Test-ReportsIgnored $Instance $FolderId $entry.path)) { $still += $entry; continue }
            $problem = Get-HandoffDiskDifference $folder $entry
            if ($problem) { $results += New-HandoffResultLine $FolderId $entry.path "ignored-not-moved" "$problem after its ignore was written; it stays on the node"; continue }
            $moved = Move-ToHandoffTrash $TrashRoot $FolderId $folder $entry
            if ($moved.ContainsKey("problem")) { $results += New-HandoffResultLine $FolderId $entry.path "ignored-not-moved" "$($moved.problem); it stays on the node" }
            else { $results += New-HandoffResultLine $FolderId $entry.path "moved" "" $moved.trash }
        }
        $waiting = $still
        if ($waiting.Count -eq 0 -or (Get-Date) -ge $Deadline) { break }
        Start-Sleep -Milliseconds 500
    }
    foreach ($entry in $waiting) { $results += New-HandoffResultLine $FolderId $entry.path "ignored-not-moved" "Syncthing does not report it ignored within $handoffIgnoreWaitSeconds s; it stays on the node" }
    return $results
}

<#
.NOTES
Empties what the executor moved into the trash $handoffTrashDays ago or earlier, by its own manifest: a
file it did not move there, or one changed since, is never deleted. Returns how many it deleted.
#>
function Clear-HandoffTrash([string]$TrashRoot) {
    $manifest = Join-Path $TrashRoot "manifest.jsonl"
    if (-not [System.IO.File]::Exists($manifest) -or (Test-IsReparsePoint $manifest)) { return 0 }
    $kept = New-Object System.Collections.Generic.List[string]
    $purged = 0
    foreach ($line in [System.IO.File]::ReadAllLines($manifest)) {
        if (-not $line.Trim()) { continue }
        try { $record = ConvertFrom-Json $line } catch { $kept.Add($line); continue }
        if (-not ($record.movedAt -is [int64] -or $record.movedAt -is [int]) -or -not (Test-IsPlainHandoffPath "$($record.trash)") -or [int64]$record.movedAt + $handoffTrashDays * 86400 -gt (Get-HandoffNow)) { $kept.Add($line); continue }
        $target = Join-Path $TrashRoot ("$($record.trash)" -replace '/', '\')
        if (-not [System.IO.File]::Exists($target) -and -not [System.IO.Directory]::Exists($target)) { continue }
        $info = [System.IO.FileInfo]::new($target)
        if (-not (Test-IsPlainHandoffFile $TrashRoot "$($record.trash)") -or $info.Length -ne [int64]$record.size -or (Get-UnixSeconds $info.LastWriteTimeUtc) -ne [int64]$record.modifiedSeconds) {
            Write-WatcherLog "hand-off: kept $($record.trash) in the trash: it is not the file the executor moved there"
            $kept.Add($line)
            continue
        }
        [System.IO.File]::Delete($target)
        $purged++
        $directory = Split-Path $target
        while ((Test-IsInsideFolder $TrashRoot $directory) -and @([System.IO.Directory]::EnumerateFileSystemEntries($directory)).Count -eq 0) {
            [System.IO.Directory]::Delete($directory)
            $directory = Split-Path $directory
        }
    }
    [System.IO.File]::WriteAllText("$manifest.new", $(if ($kept.Count) { ($kept -join "`n") + "`n" } else { "" }))
    [System.IO.File]::Replace("$manifest.new", $manifest, [NullString]::Value)
    return $purged
}

function Get-HandoffNodeValue($Root, [string]$Name) {
    try { $table = (Read-TomlFile (Get-NodeFilePath $Root))["node"] } catch { return $null }
    if (-not $table -or -not $table.ContainsKey($Name)) { return $null }
    return $table[$Name]
}

function Get-HandoffContractProblem($Contract, [string]$NodeId) {
    if (-not $Contract) { return "the contract cannot be read" }
    if ($Contract.schema -ne 1) { return "the contract is not schema 1" }
    if ($Contract.nodeId -cne $NodeId) { return "the contract names another node" }
    if ($Contract.cluster -ne $false) { return "the contract is the cluster's, which never hands off" }
    if ($Contract.apply -ne $true) { return "the contract is not in apply mode" }
    if ($null -eq $Contract.entries) { return "the contract has no list of entries" }
    try { $written = [DateTimeOffset]::Parse("$($Contract.writtenAt)", [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds() } catch { return "the contract has no time it was written" }
    $age = (Get-HandoffNow) - $written
    if ($age -gt $handoffContractMaxAgeSeconds) { return "the contract is $age s old, more than $handoffContractMaxAgeSeconds s" }
    if ($age -lt -$handoffContractMaxAheadSeconds) { return "the contract was written $(-$age) s ahead of this host's clock" }
    return $null
}

function Write-HandoffResult([string]$Path, [string]$NodeId, $Contract, [string]$Refused, [object[]]$Results, [int]$Purged) {
    $result = [ordered]@{
        schema = 1; nodeId = $NodeId; contractWrittenAt = $(if ($Contract) { "$($Contract.writtenAt)" } else { "" })
        finishedAt = [DateTimeOffset]::FromUnixTimeSeconds((Get-HandoffNow)).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
        refused = $(if ($Refused) { $Refused } else { $null }); results = @($Results); purged = $Purged
    }
    if ($Refused) { Write-WatcherLog "hand-off $NodeId`: nothing handed off: $Refused" }
    Write-JsonFile $Path $result
}

function Read-HandoffContract([string]$Path) {
    try { return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { return $null }
}

function Invoke-LockedHandoff($Instance, [string]$ContractPath, [string]$ResultPath, [string]$RootFull) {
    $nodeId = $Instance.nodeId
    $contract = Read-HandoffContract $ContractPath
    if ((Get-HandoffNodeValue $RootFull "id") -cne $nodeId) { return Write-HandoffResult $ResultPath $nodeId $contract "the node file is not node $nodeId's" @() 0 }
    if ((Get-HandoffNodeValue $RootFull "apply") -ne $true) { return Write-HandoffResult $ResultPath $nodeId $contract "the node file does not say apply = true" @() 0 }
    if ((Get-HandoffNodeValue $RootFull "kind") -eq "array") { return Write-HandoffResult $ResultPath $nodeId $contract "an array never hands off" @() 0 }
    $problem = Get-HandoffContractProblem $contract $nodeId
    if ($problem) { return Write-HandoffResult $ResultPath $nodeId $contract $problem @() 0 }
    $trashRoot = Join-Path $RootFull ".storage\handoff-trash"
    New-Item -ItemType Directory -Force -Path $trashRoot | Out-Null
    if (Test-IsReparsePoint $trashRoot) { return Write-HandoffResult $ResultPath $nodeId $contract "the trash folder is a link" @() 0 }
    $deadline = (Get-Date).AddSeconds($handoffIgnoreWaitSeconds)
    $results = @()
    foreach ($group in @($contract.entries | Group-Object -Property folderId)) {
        $results += Invoke-FolderHandoff $Instance $group.Name @($group.Group) $RootFull $trashRoot $deadline
    }
    Write-HandoffResult $ResultPath $nodeId $contract $null $results (Clear-HandoffTrash $trashRoot)
}

<#
.NOTES
The lock is an owner file opened with no sharing for the whole run: a second run cannot open it and
does nothing, and the lock goes with the process however it ends. A busy lock writes no result, so the
running run's result is never replaced by a refusal.
#>
function Invoke-NodeHandoff($Instance, [string]$ContractPath, [string]$ResultPath) {
    $root = "$($Instance.node.root)"
    if (-not $root -or -not [System.IO.Directory]::Exists($root)) { return Write-HandoffResult $ResultPath $Instance.nodeId $null "the node's root $root does not exist" @() 0 }
    $rootFull = [System.IO.Path]::GetFullPath($root)
    $storage = Join-Path $rootFull ".storage"
    if (-not [System.IO.Directory]::Exists($storage) -or (Test-IsReparsePoint $storage)) { return Write-HandoffResult $ResultPath $Instance.nodeId $null "the node's root has no .storage folder" @() 0 }
    try { $lock = [System.IO.File]::Open((Join-Path $storage "handoff.lock"), "OpenOrCreate", "ReadWrite", "None") }
    catch { Write-WatcherLog "hand-off $($Instance.nodeId): another hand-off run holds the lock; this run does nothing"; return }
    try {
        $owner = [System.Text.Encoding]::UTF8.GetBytes("$PID $((Get-Date).ToUniversalTime().ToString('s'))Z`n")
        $lock.SetLength(0)
        $lock.Write($owner, 0, $owner.Length)
        $lock.Flush()
        Invoke-LockedHandoff $Instance $ContractPath $ResultPath $rootFull
    } finally { $lock.Dispose() }
}

<#
.NOTES
Runs in the agent's own round, so a run is bounded by $handoffIgnoreWaitSeconds of waiting, well inside
the heartbeat's 30 s; only nodes whose Syncthing runs have an index to check against.
#>
function Invoke-HandoffRound {
    if (((Get-Date) - $script:lastHandoffRound).TotalSeconds -lt $handoffRoundSeconds) { return }
    $script:lastHandoffRound = Get-Date
    $folder = Get-AgentHandoffFolder $script:agentConfig.stackFolder
    foreach ($instance in @($script:syncthingInstances.Values)) {
        if ($instance.state -ne "running") { continue }
        $contract = Join-Path $folder "$($instance.nodeId).json"
        if (-not [System.IO.File]::Exists($contract)) { continue }
        try { Invoke-NodeHandoff $instance $contract (Join-Path $folder "$($instance.nodeId).result.json") }
        catch { Write-WatcherLog "hand-off $($instance.nodeId): the run failed: $_" }
    }
}
