# The layered sync's hand-off executor for the host agent's native nodes (plan call 3, the same rules as
# images/nodes/handoff.sh). It acts only on files the dashboard's contract names, only while the node's
# own node file says apply = true, and only on a file that is still the confirmed one on disk: it
# records the path as pending in <root>\.storage\handoff-pending.jsonl, appends it to the folder's
# .stignore-handoff, waits until Syncthing reports it ignored, hashes it, then renames it into
# <root>\.storage\handoff-trash\<day>\<folder id>\. A pending path is retried on later runs; its line is
# removed again only while its file is still there and was never moved (it changed, or the retries ran
# out). A moved path's line is never removed. Nothing is deleted except what this moved into the trash,
# once it is $handoffTrashDays old and a keeper still holds its version. It never asks Syncthing to
# override, revert or delete anything. Dot-sourced by the agent; defines functions and values only.

$handoffTrashDays = 7
$handoffQuietMinutes = 10
$handoffContractMaxAgeSeconds = 300
$handoffContractMaxAheadSeconds = 60
$handoffIgnoreWaitSeconds = 15
$handoffRunSeconds = 20
$handoffPendingAttempts = 10
$handoffStrayLimit = 1000
$handoffKeptLogSeconds = 86400
$handoffRoundSeconds = 60
$handoffListName = ".stignore-handoff"
$lastHandoffRound = [datetime]::MinValue
$handoffHashJobs = @{}

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

function Test-HandoffPathExists([string]$Path) { return [System.IO.File]::Exists($Path) -or [System.IO.Directory]::Exists($Path) }

<#
.NOTES
A path an ignore line can name exactly and that cannot leave its folder: `/` separated, no empty, . or
.. segment, no segment with leading or trailing whitespace (Windows drops a trailing space, so the name
on disk would not be the name in the line), and none of the characters Windows refuses in a name or
Syncthing reads as a pattern.
#>
function Test-IsPlainHandoffPath([string]$Path) {
    if (-not $Path -or $Path.StartsWith("/") -or $Path.EndsWith("/")) { return $false }
    if ($Path -match '[\\:*?"<>|\[\]{}]' -or $Path -match '[\x00-\x1f]') { return $false }
    return @($Path -split '/' | Where-Object { $_ -in @("", ".", "..") -or $_ -cne $_.Trim() }).Count -eq 0
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

<#
.NOTES
Returns $null once $Deadline passes, so one large file cannot hold the agent's round past its heartbeat;
the path is retried on the next round.
#>
function Get-StreamBlocksHash([System.IO.Stream]$Stream, [int64]$BlockSize, [datetime]$Deadline = [datetime]::MaxValue) {
    $blockHasher = [System.Security.Cryptography.SHA256]::Create()
    $outer = [System.Security.Cryptography.SHA256]::Create()
    try {
        $buffer = New-Object byte[] $BlockSize
        $hashes = New-Object System.IO.MemoryStream
        do {
            if ((Get-Date) -ge $Deadline) { return $null }
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

function Get-HandoffPath([string]$Folder, [string]$Relative) { return Join-Path $Folder ($Relative -replace '/', '\') }

function Get-HandoffMetadataDifference([string]$Folder, $Entry) {
    if (-not (Test-IsPlainHandoffFile $Folder $Entry.path)) { return "it is not a regular file inside the folder" }
    $info = [System.IO.FileInfo]::new((Get-HandoffPath $Folder $Entry.path))
    if ($info.Length -ne [int64]$Entry.size) { return "its size is $($info.Length), not the confirmed $($Entry.size)" }
    $modified = Get-UnixSeconds $info.LastWriteTimeUtc
    if ($modified -ne [int64]$Entry.modifiedSeconds) { return "it was modified at $modified, not at the confirmed $($Entry.modifiedSeconds)" }
    if ((Get-HandoffNow) - $modified -lt $handoffQuietMinutes * 60) { return "it changed within the last $handoffQuietMinutes minutes" }
    return $null
}

function Test-HandoffFileIsOpen([string]$Path) {
    try { $stream = [System.IO.File]::Open($Path, "Open", "Read", "None") } catch { return $true }
    $stream.Dispose()
    return $false
}

<#
.NOTES
The file is opened with no sharing at all, so it counts as open whenever any other process has it, and
the hash is read through that same handle, so nothing can write to it meanwhile. Returns @{ open },
@{ budget }, @{ problem } or an empty table when the content is the confirmed one.
#>
function Get-HandoffContentCheck([string]$Folder, $Entry, [datetime]$Deadline) {
    try { $stream = [System.IO.File]::Open((Get-HandoffPath $Folder $Entry.path), "Open", "Read", "None") } catch { return @{ open = $true } }
    try {
        $blockSize = Get-HandoffBlockSize ([int64]$Entry.size) ([int64]$Entry.numBlocks)
        if (-not $blockSize) { return @{ problem = "its blocks cannot be hashed" } }
        $hash = Get-StreamBlocksHash $stream $blockSize $Deadline
        if ($null -eq $hash) { return @{ budget = $true } }
        if ($hash -cne $Entry.blocksHash) { return @{ problem = "its content is not the confirmed content" } }
        return @{}
    } finally { $stream.Dispose() }
}

function Get-HandoffFileReport($Instance, [string]$FolderId, [string]$Relative) {
    return Invoke-SyncthingApi $Instance "Get" "/rest/db/file?folder=$(Get-HandoffUri $FolderId)&file=$(Get-HandoffUri $Relative)"
}

function Test-SameVersion($Left, $Right) { return (@($Left) -join "|") -ceq (@($Right) -join "|") }

<#
.NOTES
$Ignored says what the entry must read: not ignored before the ignore line, ignored at the record's
version for a pending retry.
#>
function Get-HandoffIndexDifference($Instance, [string]$FolderId, $Entry, [bool]$Ignored) {
    try { $report = Get-HandoffFileReport $Instance $FolderId $Entry.path } catch { return "its index entry cannot be read" }
    $local = $report.local
    if (-not $local) { return "it has no entry in the index" }
    if ($Ignored) {
        if (-not ($local.ignored -and (Test-SameVersion $local.version $Entry.version))) { return "its index entry is not the ignored confirmed version" }
    } else {
        if ($local.deleted -or $local.ignored -or $local.invalid) { return "its index entry is deleted, ignored or invalid" }
        if (-not (Test-SameVersion $local.version $Entry.version) -or [int64]$local.size -ne [int64]$Entry.size -or "$($local.blocksHash)" -cne $Entry.blocksHash) { return "its index entry is not the confirmed version" }
    }
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

function ConvertFrom-HandoffLine([string]$Line) {
    try { $value = ConvertFrom-Json $Line } catch { return $null }
    if ($value -is [System.Management.Automation.PSCustomObject]) { return $value }
    return $null
}

function Read-HandoffLines([string]$Path) {
    if (-not [System.IO.File]::Exists($Path)) { return @() }
    return @([System.IO.File]::ReadAllLines($Path) | Where-Object { $_.Trim() } | ForEach-Object { ConvertFrom-HandoffLine $_ } | Where-Object { $_ })
}

<#
.NOTES
Ends a last line that a torn write left without its newline before appending, so the new line is a
line of its own.
#>
function Add-HandoffText([string]$Path, [string]$Line) {
    $encoding = [System.Text.UTF8Encoding]::new($false)
    if ([System.IO.File]::Exists($Path)) {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        if ($bytes.Length -gt 0 -and $bytes[-1] -ne 10) { [System.IO.File]::AppendAllText($Path, "`n", $encoding) }
    }
    [System.IO.File]::AppendAllText($Path, "$Line`n", $encoding)
}

function Add-HandoffLine([string]$Path, $Value) { Add-HandoffText $Path (ConvertTo-Json -InputObject $Value -Compress -Depth 10) }

<#
.NOTES
Lines of the pending file that are not JSON objects (a torn write) go to a side file, so the rest still
reads.
#>
function Move-BadPendingLines($Run) {
    if (-not [System.IO.File]::Exists($Run.pendingFile)) { return }
    $lines = @([System.IO.File]::ReadAllLines($Run.pendingFile) | Where-Object { $_.Trim() })
    $bad = @($lines | Where-Object { -not (ConvertFrom-HandoffLine $_) })
    if ($bad.Count -eq 0) { return }
    foreach ($line in $bad) { Add-HandoffText "$($Run.pendingFile).bad" $line }
    Write-HandoffLines $Run.pendingFile @($lines | ForEach-Object { ConvertFrom-HandoffLine $_ } | Where-Object { $_ })
    $Run.notes += "$($bad.Count) unreadable lines of the pending file were moved to handoff-pending.jsonl.bad"
}

function Write-HandoffLines([string]$Path, [object[]]$Values) {
    $text = (@($Values | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 10 }) -join "`n")
    if ($text) { $text += "`n" }
    [System.IO.File]::WriteAllText("$Path.new", $text, [System.Text.UTF8Encoding]::new($false))
    if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Replace("$Path.new", $Path, [NullString]::Value) } else { [System.IO.File]::Move("$Path.new", $Path) }
}

function Test-IsHandoffRecord($Record, [string]$FolderId, [string]$Relative) { return $Record.folderId -ceq $FolderId -and $Record.path -ceq $Relative }

function Get-PendingRecord($Run, [string]$FolderId, [string]$Relative) {
    return @(Read-HandoffLines $Run.pendingFile | Where-Object { Test-IsHandoffRecord $_ $FolderId $Relative }) | Select-Object -First 1
}

function Add-PendingRecord($Run, $Entry) {
    if (Get-PendingRecord $Run $Entry.folderId $Entry.path) { return }
    Add-HandoffLine $Run.pendingFile ([ordered]@{ folderId = $Entry.folderId; folderPath = $Entry.folderPath; path = $Entry.path; entry = $Entry; since = (Get-HandoffNow); attempts = 0 })
}

function Remove-PendingRecord($Run, [string]$FolderId, [string]$Relative) {
    Write-HandoffLines $Run.pendingFile @(Read-HandoffLines $Run.pendingFile | Where-Object { -not (Test-IsHandoffRecord $_ $FolderId $Relative) })
}

function Add-PendingAttempt($Run, [string]$FolderId, [string]$Relative) {
    $records = @(Read-HandoffLines $Run.pendingFile)
    $attempts = 0
    foreach ($record in $records) { if (Test-IsHandoffRecord $record $FolderId $Relative) { $record.attempts = [int]$record.attempts + 1; $attempts = $record.attempts } }
    Write-HandoffLines $Run.pendingFile $records
    return $attempts
}

function Test-IsMoving($Record) { return $Record -and $Record.PSObject.Properties["moving"] -and $Record.moving -eq $true }

<#
.NOTES
A pending record marked moving counts as moved: a run that ended between the rename and its manifest
line must never lead to a release.
#>
function Test-WasMoved($Run, [string]$FolderId, [string]$Relative) {
    if (@(Read-HandoffLines $Run.manifest | Where-Object { Test-IsHandoffRecord $_ $FolderId $Relative }).Count -gt 0) { return $true }
    return Test-IsMoving (Get-PendingRecord $Run $FolderId $Relative)
}

function Set-PendingMoving($Run, [string]$FolderId, [string]$Relative, [string]$Trash) {
    $records = @(Read-HandoffLines $Run.pendingFile | ForEach-Object {
        if (Test-IsHandoffRecord $_ $FolderId $Relative) {
            $record = [ordered]@{}
            foreach ($property in $_.PSObject.Properties) { if ($property.Name -notin @("moving", "trash")) { $record[$property.Name] = $property.Value } }
            if ($Trash) { $record.moving = $true; $record.trash = $Trash }
            [pscustomobject]$record
        } else { $_ }
    })
    Write-HandoffLines $Run.pendingFile $records
}

<#
.NOTES
The one way a line leaves .stignore-handoff: the path is this executor's pending one, its file is still
there, and it was never moved, so removing the line puts a file that is still on the node back into sync.
#>
function Invoke-HandoffRelease($Run, $Instance, [string]$FolderId, [string]$Folder, [string]$Relative, [string]$Reason) {
    if (-not (Get-PendingRecord $Run $FolderId $Relative) -or (Test-WasMoved $Run $FolderId $Relative) -or -not (Test-HandoffPathExists (Get-HandoffPath $Folder $Relative))) {
        return New-HandoffResultLine $FolderId $Relative "ignored-not-moved" "$Reason; its line stays, since its file is not a pending one still on the node"
    }
    $list = Join-Path $Folder $handoffListName
    $kept = @([System.IO.File]::ReadAllLines($list) | Where-Object { $_ -cne "/$Relative" })
    $text = ($kept -join "`n")
    if ($text) { $text += "`n" }
    [System.IO.File]::WriteAllText("$list.new", $text, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Replace("$list.new", $list, [NullString]::Value)
    Remove-PendingRecord $Run $FolderId $Relative
    try { Invoke-SyncthingApi $Instance "Post" "/rest/db/scan?folder=$(Get-HandoffUri $FolderId)&sub=$(Get-HandoffUri $Relative)" | Out-Null } catch { Write-WatcherLog "hand-off $FolderId/$Relative`: the rescan was not accepted; Syncthing's own picks it up" }
    return New-HandoffResultLine $FolderId $Relative "released" "$Reason; its ignore line was removed, so it syncs again"
}

function Get-RetryOrRelease($Run, $Instance, [string]$FolderId, [string]$Folder, [string]$Relative, [string]$Reason) {
    $attempts = Add-PendingAttempt $Run $FolderId $Relative
    if ($attempts -ge $handoffPendingAttempts) { return Invoke-HandoffRelease $Run $Instance $FolderId $Folder $Relative "$Reason on $attempts runs" }
    return New-HandoffResultLine $FolderId $Relative "ignored-not-moved" "$Reason; it is retried next run"
}

<#
.NOTES
MoveFileEx without MOVEFILE_COPY_ALLOWED renames or fails: it never copies and deletes across volumes,
and without MOVEFILE_REPLACE_EXISTING it never overwrites a file in the trash.
#>
function Move-HandoffFile([string]$Source, [string]$Target) {
    return [StorageCompose.HandoffNative]::MoveFileEx($Source, $Target, 0)
}

<#
.NOTES
Returns @{ trash } when moved, @{ stayed } with the reason when the file is still at its path,
@{ putBack } when it changed during the rename and is back at its path, and @{ unlisted } with the trash
path when it is in the trash and could not be put back.
#>
function Move-ToHandoffTrash($Run, [string]$FolderId, [string]$Folder, $Entry) {
    $day = [DateTimeOffset]::FromUnixTimeSeconds((Get-HandoffNow)).UtcDateTime.ToString("yyyy-MM-dd")
    $relative = "$day/$FolderId/$($Entry.path)"
    $source = Get-HandoffPath $Folder $Entry.path
    $target = Join-Path $Run.trashRoot ($relative -replace '/', '\')
    if (Test-HandoffPathExists $target) { return @{ stayed = "a file of that name is in the trash already" } }
    try { New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null } catch { return @{ stayed = "the trash folder cannot be made" } }
    Set-PendingMoving $Run $FolderId $Entry.path $relative
    if (-not (Move-HandoffFile $source $target)) {
        if ([System.IO.File]::Exists($source) -and -not (Test-HandoffPathExists $target)) { Set-PendingMoving $Run $FolderId $Entry.path "" }
        return @{ stayed = "it could not be renamed into the trash" }
    }
    $moved = [System.IO.FileInfo]::new($target)
    if ($moved.Length -ne [int64]$Entry.size -or (Get-UnixSeconds $moved.LastWriteTimeUtc) -ne [int64]$Entry.modifiedSeconds) {
        if ((Move-HandoffFile $target $source) -and [System.IO.File]::Exists($source) -and -not [System.IO.File]::Exists($target)) { Set-PendingMoving $Run $FolderId $Entry.path ""; return @{ putBack = $true } }
        Add-HandoffLine (Join-Path $Run.trashRoot "unlisted.jsonl") ([ordered]@{ at = (Get-HandoffNow); trash = $relative; folderId = $FolderId; path = $Entry.path; reason = "changed while it was moved and could not be put back" })
        return @{ unlisted = $relative }
    }
    Add-MovedRecord $Run $FolderId $Entry $relative
    return @{ trash = $relative }
}

function Add-MovedRecord($Run, [string]$FolderId, $Entry, [string]$Relative) {
    Add-HandoffLine $Run.manifest ([ordered]@{
        movedAt = (Get-HandoffNow); trash = $Relative; folderId = $FolderId; folderPath = $Entry.folderPath; path = $Entry.path; version = @($Entry.version)
        size = [int64]$Entry.size; modifiedSeconds = [int64]$Entry.modifiedSeconds; blocksHash = $Entry.blocksHash; keeper = $Entry.keeper; keeperDevice = $Entry.keeperDevice
    })
}

<#
.NOTES
A record marked moving from a run that ended mid-move: the copy in the trash and none at the path means
the rename happened, so its manifest line is written now; a file at the path and none in the trash means
it did not, so the mark is cleared and the path retried as usual; anything else stays, reported.
Returns a result line when it settled the path, $null to go on with the retry.
#>
function Resume-MovingRecord($Run, [string]$FolderId, [string]$Folder, $Entry) {
    $record = Get-PendingRecord $Run $FolderId $Entry.path
    $relative = if ($record.PSObject.Properties["trash"]) { "$($record.trash)" } else { "" }
    $source = Get-HandoffPath $Folder $Entry.path
    $target = if ($relative) { Join-Path $Run.trashRoot ($relative -replace '/', '\') } else { "" }
    if ($relative -and (Test-IsPlainHandoffPath $relative) -and (Test-IsPlainHandoffFile $Run.trashRoot $relative) -and -not (Test-HandoffPathExists $source)) {
        $info = [System.IO.FileInfo]::new($target)
        if ($info.Length -eq [int64]$Entry.size -and (Get-UnixSeconds $info.LastWriteTimeUtc) -eq [int64]$Entry.modifiedSeconds) {
            Add-MovedRecord $Run $FolderId $Entry $relative
            Remove-PendingRecord $Run $FolderId $Entry.path
            return New-HandoffResultLine $FolderId $Entry.path "moved" "a run ended between its rename and its manifest line; the line is written now" $relative
        }
    }
    if ((Test-HandoffPathExists $source) -and (-not $target -or -not (Test-HandoffPathExists $target))) { Set-PendingMoving $Run $FolderId $Entry.path ""; return $null }
    return New-HandoffResultLine $FolderId $Entry.path "ignored-not-moved" "a run ended while it was moved and neither its path nor its trash copy is as recorded; it is left as it is"
}

<#
.NOTES
After Syncthing reports the path ignored. Its content was hashed before the ignore line, through a handle
no other process could write through; here its size, time and openness are checked once more, so a
change since then (which moves the modification time) is caught without a second read of the file.
#>
function Complete-HandoffPath($Run, $Instance, [string]$FolderId, [string]$Folder, $Entry) {
    $problem = Get-HandoffMetadataDifference $Folder $Entry
    if ($problem) { return Invoke-HandoffRelease $Run $Instance $FolderId $Folder $Entry.path "$problem after its ignore was written" }
    if (Test-HandoffFileIsOpen (Get-HandoffPath $Folder $Entry.path)) { return Get-RetryOrRelease $Run $Instance $FolderId $Folder $Entry.path "it is open" }
    $moved = Move-ToHandoffTrash $Run $FolderId $Folder $Entry
    if ($moved.ContainsKey("trash")) { Remove-PendingRecord $Run $FolderId $Entry.path; return New-HandoffResultLine $FolderId $Entry.path "moved" "" $moved.trash }
    if ($moved.ContainsKey("putBack")) { return Invoke-HandoffRelease $Run $Instance $FolderId $Folder $Entry.path "it changed while it was moved and was put back" }
    if ($moved.ContainsKey("unlisted")) {
        Remove-PendingRecord $Run $FolderId $Entry.path
        return New-HandoffResultLine $FolderId $Entry.path "in-trash-unlisted" "it changed while it was moved and could not be put back; the trash copy is never emptied" $moved.unlisted
    }
    return Get-RetryOrRelease $Run $Instance $FolderId $Folder $Entry.path $moved.stayed
}

function Get-HandoffContractAgeProblem($Contract) {
    try { $written = [DateTimeOffset]::Parse("$($Contract.writtenAt)", [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds() } catch { return "the contract has no time it was written" }
    $age = (Get-HandoffNow) - $written
    if ($age -gt $handoffContractMaxAgeSeconds) { return "the contract is $age s old, more than $handoffContractMaxAgeSeconds s" }
    if ($age -lt -$handoffContractMaxAheadSeconds) { return "the contract was written $(-$age) s ahead of this host's clock" }
    return $null
}

<#
.NOTES
A pending path from an earlier run: returns "wait" to poll it, "finish" when it is ignored, or a result
line when it was settled here.
#>
function Get-RetryState($Run, $Instance, [string]$FolderId, [string]$Folder, $Entry) {
    if (Test-IsMoving (Get-PendingRecord $Run $FolderId $Entry.path)) {
        $resumed = Resume-MovingRecord $Run $FolderId $Folder $Entry
        if ($resumed) { return $resumed }
    }
    if (-not (Test-HandoffPathExists (Get-HandoffPath $Folder $Entry.path))) {
        Remove-PendingRecord $Run $FolderId $Entry.path
        return New-HandoffResultLine $FolderId $Entry.path "refused" "it is gone from the node without being moved; its ignore line stays"
    }
    $problem = Get-HandoffMetadataDifference $Folder $Entry
    if ($problem) { return Invoke-HandoffRelease $Run $Instance $FolderId $Folder $Entry.path "$problem after its ignore was written" }
    if (-not (Test-ReportsIgnored $Instance $FolderId $Entry.path)) { return "wait" }
    $problem = Get-HandoffIndexDifference $Instance $FolderId $Entry $true
    if ($problem) { return Get-RetryOrRelease $Run $Instance $FolderId $Folder $Entry.path $problem }
    return "finish"
}

function Invoke-HandoffPathSafely([string]$FolderId, [string]$Relative, [string]$Outcome, [scriptblock]$Action) {
    try { return & $Action } catch { return New-HandoffResultLine $FolderId $Relative $Outcome "the executor failed on it: $($_.Exception.Message)" }
}

<#
.NOTES
One folder: earlier pending paths retried, then the contract's entries checked against the index, the
file's size and time, and its content, hashed before any ignore so a file that does not hash leaves no
trace; recorded as pending, ignored together with one rescan of their paths, and each, once Syncthing
reports it ignored, checked again and moved. Every path runs in its own try, so a
failure leaves only that path to its outcome. The folder has its own deadline, within the run's, checked
before each path.
#>
function Invoke-FolderHandoff($Run, $Instance, [string]$FolderId, [string]$Folder, [object[]]$Entries) {
    $results = @()
    $folder = $Folder.TrimEnd('\')
    $pending = @(Read-HandoffLines $Run.pendingFile | Where-Object { $_.folderId -ceq $FolderId } | ForEach-Object { $_.entry })
    $problem = Get-HandoffContractAgeProblem $Run.contract
    if ($problem) { $problem = "$problem by this folder's turn" }
    if (-not $problem) { $problem = Get-HandoffFolderDifference $Instance $FolderId $folder $Run.rootFull }
    if ($problem) {
        $results += @($Entries | ForEach-Object { New-HandoffResultLine $FolderId $_.path "refused" $problem })
        foreach ($entry in $pending) {
            $results += Invoke-HandoffPathSafely $FolderId $entry.path "ignored-not-moved" { Get-RetryOrRelease $Run $Instance $FolderId $folder $entry.path $problem }
        }
        return $results
    }
    $waiting = @()
    $retrying = @{}
    $subs = ""
    foreach ($entry in $pending) {
        $state = Invoke-HandoffPathSafely $FolderId $entry.path "ignored-not-moved" { Get-RetryState $Run $Instance $FolderId $folder $entry }
        if ($state -is [string]) {
            $retrying[$entry.path] = $true
            $waiting += $entry
            if ($state -eq "wait") { $subs += "&sub=$(Get-HandoffUri $entry.path)" }
        } else { $results += $state }
    }
    foreach ($entry in $Entries) {
        if (Get-PendingRecord $Run $FolderId $entry.path) { continue }
        $line = Invoke-HandoffPathSafely $FolderId $entry.path "refused" {
            if (-not (Test-IsPlainHandoffPath $entry.path) -or $entry.type -ne "FILE_INFO_TYPE_FILE") { return New-HandoffResultLine $FolderId $entry.path "refused" "the path is not a plain file path inside the folder" }
            if (-not (Test-IsPlainHandoffFile $folder $entry.path)) { return New-HandoffResultLine $FolderId $entry.path "refused" "it is not a regular file inside the folder, or a link is on its way" }
            $problem = Get-HandoffIndexDifference $Instance $FolderId $entry $false
            if (-not $problem) { $problem = Get-HandoffMetadataDifference $folder $entry }
            if ($problem) { return New-HandoffResultLine $FolderId $entry.path "refused" $problem }
            $hashed = Get-HandoffHashBeforeIgnore $Run $FolderId $folder $entry
            if ($hashed) { return $hashed }
            Add-PendingRecord $Run $entry
            $list = Join-Path $folder $handoffListName
            if (-not (Test-FileHasLine $list "/$($entry.path)")) { Add-HandoffText $list "/$($entry.path)" }
            return $null
        }
        if ($line) { $results += $line; continue }
        $waiting += $entry
        $subs += "&sub=$(Get-HandoffUri $entry.path)"
    }
    if ($subs) {
        try { Invoke-SyncthingApi $Instance "Post" "/rest/db/scan?folder=$(Get-HandoffUri $FolderId)$subs" | Out-Null } catch { Write-WatcherLog "hand-off $FolderId`: the rescan was not accepted; waiting for Syncthing's own" }
    }
    $deadline = (Get-Date).AddSeconds($handoffIgnoreWaitSeconds)
    if ($deadline -gt $Run.deadline) { $deadline = $Run.deadline }
    while ($waiting.Count -gt 0) {
        $still = @()
        foreach ($entry in $waiting) {
            $line = Invoke-HandoffPathSafely $FolderId $entry.path "ignored-not-moved" {
                if ((Get-Date) -ge $deadline) {
                    if ($retrying.ContainsKey($entry.path)) { return Get-RetryOrRelease $Run $Instance $FolderId $folder $entry.path "Syncthing did not report it ignored" }
                    return New-HandoffResultLine $FolderId $entry.path "ignored-not-moved" "Syncthing did not report it ignored within $handoffIgnoreWaitSeconds s; it is retried next run"
                }
                if (-not (Test-ReportsIgnored $Instance $FolderId $entry.path)) { return "wait" }
                return Complete-HandoffPath $Run $Instance $FolderId $folder $entry
            }
            if ($line -is [string]) { $still += $entry } else { $results += $line }
        }
        $waiting = $still
        if ($waiting.Count -gt 0) { Start-Sleep -Milliseconds 500 }
    }
    $results += @(Get-HandoffStrays $Run $FolderId $folder)
    return $results
}

function Get-HashJobKey($Run, [string]$FolderId, $Entry) { return "$($Run.rootFull)|$FolderId|$($Entry.path)|$(@($Entry.version) -join ',')|$($Entry.size)|$($Entry.modifiedSeconds)" }

function Test-HashJobIsDone($Job) { return $Job.handle.IsCompleted }

function Remove-HashJob([string]$Key) {
    $job = $script:handoffHashJobs[$Key]
    if (-not $job) { return }
    try { if (-not $job.handle.IsCompleted) { $job.shell.Stop() } } catch { }
    try { $job.shell.Dispose(); $job.space.Dispose() } catch { }
    $script:handoffHashJobs.Remove($Key)
}

<#
.NOTES
A hash the run's deadline cut short goes on to one background runspace, so a large file never stalls the round
that carries the heartbeat: it reads the whole file through a handle with no sharing, as the round does, and
the file stays where it is with nothing written about it until the next run takes the result, whose metadata
check would catch a change since. One at a time per agent: the disk is read in order, not in parallel.
#>
function Start-HashJob([string]$Key, [string]$Path, [int64]$BlockSize) {
    foreach ($other in @($script:handoffHashJobs.Keys | Where-Object { $_ -cne $Key })) { if ($script:handoffHashJobs[$other].handle.IsCompleted) { Remove-HashJob $other } }
    if ($script:handoffHashJobs.Count -ge 1) { return }
    $definition = (Get-Item function:\Get-StreamBlocksHash).Definition
    $worker = "param([string]`$Path, [int64]`$BlockSize)`nfunction Get-StreamBlocksHash {$definition}`ntry { `$stream = [System.IO.File]::Open(`$Path, 'Open', 'Read', 'None') } catch { return [pscustomobject]@{ open = `$true; hash = `$null } }`ntry { return [pscustomobject]@{ open = `$false; hash = (Get-StreamBlocksHash `$stream `$BlockSize) } } finally { `$stream.Dispose() }"
    $space = [runspacefactory]::CreateRunspace()
    $space.Open()
    $shell = [powershell]::Create()
    $shell.Runspace = $space
    [void]$shell.AddScript($worker).AddArgument($Path).AddArgument($BlockSize)
    $script:handoffHashJobs[$Key] = [pscustomobject]@{ shell = $shell; space = $space; handle = $shell.BeginInvoke() }
}

function Stop-HandoffHashJobs { foreach ($key in @($script:handoffHashJobs.Keys)) { Remove-HashJob $key } }

function Get-HashJobOutcome([string]$Key) {
    $job = $script:handoffHashJobs[$Key]
    try { $answer = @($job.shell.EndInvoke($job.handle)) | Select-Object -First 1 } catch { $answer = $null }
    Remove-HashJob $Key
    return $answer
}

function New-HashDeferredLine([string]$FolderId, $Entry) {
    return New-HandoffResultLine $FolderId $Entry.path "deferred" "it is being hashed in the background; nothing was written for it"
}

<#
.NOTES
The content check before the ignore line: an open file and a file of another content are refused with nothing
written, and a file too large to hash within the run goes on in the background (Start-HashJob), its next run
taking the result. Returns a result line, or $null when the file is the confirmed one.
#>
function Get-HandoffHashBeforeIgnore($Run, [string]$FolderId, [string]$Folder, $Entry) {
    $key = Get-HashJobKey $Run $FolderId $Entry
    if ($script:handoffHashJobs.ContainsKey($key)) {
        if (-not (Test-HashJobIsDone $script:handoffHashJobs[$key])) { return New-HashDeferredLine $FolderId $Entry }
        $outcome = Get-HashJobOutcome $key
        if ($outcome -and $outcome.open) { return New-HandoffResultLine $FolderId $Entry.path "refused" "it is open" }
        if ($outcome -and $outcome.hash -ceq $Entry.blocksHash) { return $null }
        if ($outcome -and $outcome.hash) { return New-HandoffResultLine $FolderId $Entry.path "refused" "its content is not the confirmed content" }
    }
    $check = Get-HandoffContentCheck $Folder $Entry $Run.deadline
    if ($check.ContainsKey("open")) { return New-HandoffResultLine $FolderId $Entry.path "refused" "it is open" }
    if ($check.ContainsKey("problem")) { return New-HandoffResultLine $FolderId $Entry.path "refused" $check.problem }
    if (-not $check.ContainsKey("budget")) { return $null }
    Start-HashJob $key (Get-HandoffPath $Folder $Entry.path) (Get-HandoffBlockSize ([int64]$Entry.size) ([int64]$Entry.numBlocks))
    return New-HashDeferredLine $FolderId $Entry
}

<#
.NOTES
A file at a path the list ignores that is not pending and is newer than its hand-off is on this node only.
At most $handoffStrayLimit lines per folder and run, from where the last run stopped.
#>
function Get-HandoffStrays($Run, [string]$FolderId, [string]$Folder) {
    $moves = @(Read-HandoffLines $Run.manifest)
    $lines = @([System.IO.File]::ReadAllLines((Join-Path $Folder $handoffListName)))
    $offsetsFile = Join-Path $Run.rootFull ".storage\handoff-strays.json"
    $offsets = $null
    try { $offsets = [System.IO.File]::ReadAllText($offsetsFile) | ConvertFrom-Json } catch { }
    if (-not ($offsets -is [System.Management.Automation.PSCustomObject])) { $offsets = [pscustomobject]@{} }
    $offset = 0
    if ($offsets.PSObject.Properties[$FolderId]) { $offset = [int]$offsets.$FolderId }
    if ($offset -ge $lines.Count) { $offset = 0 }
    $next = if ($offset + $handoffStrayLimit -lt $lines.Count) { $offset + $handoffStrayLimit } else { 0 }
    $offsets | Add-Member -NotePropertyName $FolderId -NotePropertyValue $next -Force
    [System.IO.File]::WriteAllText($offsetsFile, (ConvertTo-Json -InputObject $offsets -Compress))
    foreach ($line in @($lines | Select-Object -Skip $offset -First $handoffStrayLimit)) {
        if (-not $line.StartsWith("/")) { continue }
        $relative = $line.Substring(1)
        if (-not (Test-IsPlainHandoffPath $relative) -or -not (Test-IsPlainHandoffFile $Folder $relative) -or (Get-PendingRecord $Run $FolderId $relative)) { continue }
        $modified = Get-UnixSeconds ([System.IO.File]::GetLastWriteTimeUtc((Get-HandoffPath $Folder $relative)))
        $move = @($moves | Where-Object { Test-IsHandoffRecord $_ $FolderId $relative }) | Select-Object -Last 1
        if (-not $move) { New-HandoffResultLine $FolderId $relative "unsynced-at-handed-off-path" "a file is at a path the hand-off list ignores, with no record of its hand-off, so it is on this node only" }
        elseif ($modified -gt [int64]$move.movedAt) { New-HandoffResultLine $FolderId $relative "unsynced-at-handed-off-path" "a file newer than its hand-off is at a path the hand-off list ignores, so it is on this node only" }
    }
}

function Get-VersionCounters($Version) {
    $counters = @{}
    foreach ($counter in @($Version)) {
        $device, $value = "$counter" -split ':', 2
        $number = 0L
        if ([int64]::TryParse($value, [ref]$number)) { $counters[$device] = $number } else { $counters[$device] = -1L }
    }
    return $counters
}

<#
.NOTES
A global version descends from the recorded one when it has every recorded counter at least as large,
so a keeper's later edit still holds the content handed off.
#>
function Test-VersionDescends($Global, $Recorded) {
    $globalCounters = Get-VersionCounters $Global
    foreach ($entry in (Get-VersionCounters $Recorded).GetEnumerator()) {
        if (-not $globalCounters.ContainsKey($entry.Key) -or $globalCounters[$entry.Key] -lt $entry.Value) { return $false }
    }
    return $true
}

<#
.NOTES
The recorded keeper must be connected to this node now (one last seen hours ago may have lost the file
since), in the path's availability not from a temporary file, and the global version must descend from
the recorded one, not deleted.
#>
function Get-TrashKeeperProblem($Run, $Instance, $Record) {
    if (-not $Record.PSObject.Properties["version"] -or @($Record.version).Count -eq 0) { return "no version was recorded with it" }
    if (-not $Record.PSObject.Properties["keeperDevice"] -or -not $Record.keeperDevice) { return "no keeper was recorded with it" }
    $device = "$($Record.keeperDevice)"
    if ($null -eq $Run.connections) {
        try { $Run.connections = Invoke-SyncthingApi $Instance "Get" "/rest/system/connections" } catch { $Run.connections = [pscustomobject]@{ connections = [pscustomobject]@{} } }
    }
    $connection = $Run.connections.connections.PSObject.Properties[$device]
    if (-not $connection -or $connection.Value.connected -ne $true) { return "its keeper is not connected to this node" }
    try { $report = Get-HandoffFileReport $Instance $Record.folderId $Record.path } catch { return "its index entry cannot be read" }
    if ($report.global.PSObject.Properties["deleted"] -and $report.global.deleted) { return "the network has its deletion" }
    if (-not (Test-VersionDescends $report.global.version $Record.version)) { return "the network no longer has its version or a later one" }
    if (@($report.availability | Where-Object { $_ -and $_.id -ceq $device -and -not $_.fromTemporary }).Count -eq 0) { return "its keeper does not hold it, as this node sees it" }
    return $null
}

<#
.NOTES
The result lists a kept copy once per run; the log says it again only when the reason changes or a day
passed, by the keptReason and keptAt the manifest line carries. Returns the manifest line to keep.
#>
function Add-TrashKept($Run, $Record, [string]$Line, [string]$Reason) {
    if (-not @($Run.trash | Where-Object { $_.trash -ceq "$($Record.trash)" }).Count) {
        $Run.trash += [pscustomobject][ordered]@{ trash = "$($Record.trash)"; folderId = "$($Record.folderId)"; path = "$($Record.path)"; reason = $Reason }
    }
    $lastReason = if ($Record.PSObject.Properties["keptReason"]) { "$($Record.keptReason)" } else { "" }
    $lastAt = if ($Record.PSObject.Properties["keptAt"]) { [int64]$Record.keptAt } else { 0 }
    if ($lastReason -ceq $Reason -and $lastAt + $handoffKeptLogSeconds -gt (Get-HandoffNow)) { return $Line }
    Write-WatcherLog "hand-off: kept $($Record.trash) in the trash: $Reason"
    $Record | Add-Member -NotePropertyName keptReason -NotePropertyValue $Reason -Force
    $Record | Add-Member -NotePropertyName keptAt -NotePropertyValue (Get-HandoffNow) -Force
    return ConvertTo-Json -InputObject $Record -Compress -Depth 10
}

<#
.NOTES
Empties what the executor moved into the trash $handoffTrashDays ago or earlier, by its own manifest: a
file it did not move there, one changed since, one outside the trash or behind a link, and one whose
version no keeper holds any more are never deleted (RULES.md section 6).
#>
function Clear-HandoffTrash($Run, $Instance) {
    $manifest = $Run.manifest
    if (-not [System.IO.File]::Exists($manifest) -or (Test-IsReparsePoint $manifest)) { return }
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($line in [System.IO.File]::ReadAllLines($manifest)) {
        if (-not $line.Trim()) { continue }
        try { $record = ConvertFrom-Json $line } catch { $kept.Add($line); continue }
        if (-not ($record.movedAt -is [int64] -or $record.movedAt -is [int]) -or [int64]$record.movedAt + $handoffTrashDays * 86400 -gt (Get-HandoffNow)) { $kept.Add($line); continue }
        if (-not (Test-IsPlainHandoffPath "$($record.trash)")) { $kept.Add((Add-TrashKept $Run $record $line "its manifest line points outside the trash")); continue }
        $target = Join-Path $Run.trashRoot ("$($record.trash)" -replace '/', '\')
        if (-not (Test-HandoffPathExists $target)) { continue }
        $info = [System.IO.FileInfo]::new($target)
        if (-not (Test-IsPlainHandoffFile $Run.trashRoot "$($record.trash)") -or $info.Length -ne [int64]$record.size -or (Get-UnixSeconds $info.LastWriteTimeUtc) -ne [int64]$record.modifiedSeconds) {
            $kept.Add((Add-TrashKept $Run $record $line "it is not the file the executor moved there"))
            continue
        }
        $problem = Get-TrashKeeperProblem $Run $Instance $record
        if ($problem) { $kept.Add((Add-TrashKept $Run $record $line $problem)); continue }
        [System.IO.File]::Delete($target)
        $Run.purged++
        $directory = Split-Path $target
        while ((Test-IsInsideFolder $Run.trashRoot $directory) -and @([System.IO.Directory]::EnumerateFileSystemEntries($directory)).Count -eq 0) {
            [System.IO.Directory]::Delete($directory)
            $directory = Split-Path $directory
        }
    }
    [System.IO.File]::WriteAllText("$manifest.new", $(if ($kept.Count) { ($kept -join "`n") + "`n" } else { "" }))
    [System.IO.File]::Replace("$manifest.new", $manifest, [NullString]::Value)
}

function Get-HandoffNodeValue($Root, [string]$Name) {
    try { $table = (Read-TomlFile (Get-NodeFilePath $Root))["node"] } catch { return $null }
    if (-not $table -or -not $table.ContainsKey($Name)) { return $null }
    return $table[$Name]
}

<#
.NOTES
A contract the dashboard holds (a stop, an unknown space) names no file: the run moves and ignores
nothing, pending paths included, and still empties the trash under its own keeper check.
#>
function Test-IsTrashOnlyContract($Contract) {
    return $Contract.PSObject.Properties["trashOnly"] -and $Contract.trashOnly -eq $true -and @($Contract.entries).Count -eq 0 -and $null -ne $Contract.entries
}

<#
.NOTES
Only the copies the run kept for their age alone: one kept for a reason (no keeper holds it, it changed)
does not leave by itself, so it frees nothing the dashboard may count on.
#>
function Get-HandoffTrashBytes($Run) {
    $held = @($Run.trash | ForEach-Object { "$($_.trash)" })
    $total = [int64]0
    foreach ($record in @(Read-HandoffLines $Run.manifest)) {
        if ($held -ccontains "$($record.trash)") { continue }
        if ($record.PSObject.Properties["size"] -and $record.size -is [ValueType]) { $total += [int64]$record.size }
    }
    return $total
}

function Get-HandoffContractProblem($Contract, [string]$NodeId) {
    if (-not $Contract) { return "the contract cannot be read" }
    if ($Contract.schema -ne 1) { return "the contract is not schema 1" }
    if ($Contract.nodeId -cne $NodeId) { return "the contract names another node" }
    if ($Contract.cluster -ne $false) { return "the contract is the cluster's, which never hands off" }
    if ($Contract.apply -ne $true -and -not (Test-IsTrashOnlyContract $Contract)) { return "the contract is not in apply mode" }
    if ($null -eq $Contract.entries) { return "the contract has no list of entries" }
    return Get-HandoffContractAgeProblem $Contract
}

function Write-HandoffResult([string]$Path, [string]$NodeId, $Contract, [string]$Refused, [object[]]$Results, [object[]]$Trash, [int]$Purged, [object[]]$Notes = @(), $TrashBytes = $null) {
    $result = [ordered]@{
        schema = 1; nodeId = $NodeId; contractWrittenAt = $(if ($Contract) { "$($Contract.writtenAt)" } else { "" })
        finishedAt = [DateTimeOffset]::FromUnixTimeSeconds((Get-HandoffNow)).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
        refused = $(if ($Refused) { $Refused } else { $null }); results = @($Results); trash = @($Trash); notes = @($Notes); purged = $Purged
    }
    if ($null -ne $TrashBytes) { $result["trashBytes"] = $TrashBytes }
    if ($Refused) { Write-WatcherLog "hand-off $NodeId`: nothing handed off: $Refused" }
    Write-JsonFile $Path $result
}

<#
.NOTES
Read once: every later step uses this copy, so a contract the dashboard replaces mid-run changes nothing
in it, and its age is checked again before each folder.
#>
function Read-HandoffContract([string]$Path) {
    try { return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json } catch { return $null }
}

function Get-HandoffRunFolders($Run) {
    $folders = [ordered]@{}
    foreach ($entry in @($Run.contract.entries)) { if (-not $folders.Contains("$($entry.folderId)")) { $folders["$($entry.folderId)"] = "$($entry.folderPath)" } }
    foreach ($record in @(Read-HandoffLines $Run.pendingFile) + @(Read-HandoffLines $Run.manifest)) {
        if ($record.PSObject.Properties["folderPath"] -and $record.folderPath -and -not $folders.Contains("$($record.folderId)")) { $folders["$($record.folderId)"] = "$($record.folderPath)" }
    }
    return $folders
}

function Get-UnlistedTrash($Run) {
    return @(Read-HandoffLines (Join-Path $Run.trashRoot "unlisted.jsonl") | ForEach-Object {
        [pscustomobject][ordered]@{ trash = "$($_.trash)"; folderId = "$($_.folderId)"; path = "$($_.path)"; reason = "in the trash outside the manifest, never emptied: $($_.reason)" }
    })
}

function Invoke-LockedHandoff($Instance, [string]$ContractPath, [string]$ResultPath, [string]$RootFull) {
    $nodeId = $Instance.nodeId
    $contract = Read-HandoffContract $ContractPath
    if ((Get-HandoffNodeValue $RootFull "id") -cne $nodeId) { return Write-HandoffResult $ResultPath $nodeId $contract "the node file is not node $nodeId's" @() @() 0 }
    if ((Get-HandoffNodeValue $RootFull "kind") -eq "array") { return Write-HandoffResult $ResultPath $nodeId $contract "an array never hands off" @() @() 0 }
    $problem = Get-HandoffContractProblem $contract $nodeId
    if ($problem) { return Write-HandoffResult $ResultPath $nodeId $contract $problem @() @() 0 }
    if ($contract.apply -eq $true -and (Get-HandoffNodeValue $RootFull "apply") -ne $true) { return Write-HandoffResult $ResultPath $nodeId $contract "the node file does not say apply = true" @() @() 0 }
    $trashRoot = Join-Path $RootFull ".storage\handoff-trash"
    New-Item -ItemType Directory -Force -Path $trashRoot | Out-Null
    if (Test-IsReparsePoint $trashRoot) { return Write-HandoffResult $ResultPath $nodeId $contract "the trash folder is a link" @() @() 0 }
    $run = [pscustomobject]@{
        contract = $contract; rootFull = $RootFull; trashRoot = $trashRoot; manifest = Join-Path $trashRoot "manifest.jsonl"
        pendingFile = Join-Path $RootFull ".storage\handoff-pending.jsonl"
        deadline = (Get-Date).AddSeconds($handoffRunSeconds); trash = @(); purged = 0; connections = $null; notes = @()
    }
    $results = @()
    if ($contract.apply -eq $true) {
        Move-BadPendingLines $run
        $folders = Get-HandoffRunFolders $run
        foreach ($folderId in @($folders.Keys)) {
            $entries = @($contract.entries | Where-Object { $_.folderId -ceq $folderId })
            try { $results += Invoke-FolderHandoff $run $Instance $folderId $folders[$folderId] $entries }
            catch { $results += @($entries | ForEach-Object { New-HandoffResultLine $folderId $_.path "refused" "the executor failed on its folder: $($_.Exception.Message)" }) }
        }
    } else {
        $run.notes = @($run.notes) + "the contract holds every hand-off: only the trash is emptied"
    }
    try { Clear-HandoffTrash $run $Instance } catch { Write-WatcherLog "hand-off $nodeId`: the trash was not emptied: $_" }
    Write-HandoffResult $ResultPath $nodeId $contract $null $results (@($run.trash) + @(Get-UnlistedTrash $run)) $run.purged $run.notes (Get-HandoffTrashBytes $run)
}

<#
.NOTES
The lock is an owner file opened with no sharing for the whole run: a second run cannot open it and
does nothing, and the lock goes with the process however it ends. A busy lock writes no result, so the
running run's result is never replaced by a refusal.
#>
function Invoke-NodeHandoff($Instance, [string]$ContractPath, [string]$ResultPath) {
    $root = "$($Instance.node.root)"
    if (-not $root -or -not [System.IO.Directory]::Exists($root)) { return Write-HandoffResult $ResultPath $Instance.nodeId $null "the node's root $root does not exist" @() @() 0 }
    $rootFull = [System.IO.Path]::GetFullPath($root)
    $storage = Join-Path $rootFull ".storage"
    if (-not [System.IO.Directory]::Exists($storage) -or (Test-IsReparsePoint $storage)) { return Write-HandoffResult $ResultPath $Instance.nodeId $null "the node's root has no .storage folder" @() @() 0 }
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
Runs in the agent's own round, so a run is bounded by $handoffRunSeconds of waiting and hashing, inside
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
