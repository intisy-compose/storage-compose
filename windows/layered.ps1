# The layered sync on the host agent's side of the dashboard: a stack node's policy and hand-off lists,
# which the dashboard asks for in files beside its contracts, and a joined device's report, the plan and
# contract it answers, and the changes it applies to the node's own Syncthing. Dot-sourced by the agent;
# defines functions and values only.

$agentPolicyMaxAgeSeconds = 300
$joinedLayeredIntervalSeconds = 60
$joinedReportBudgetSeconds = 8
$joinedReportFilesLimit = 200
$joinedOpTimeoutMilliseconds = 5000
$lastJoinedLayered = [datetime]::MinValue
$joinedLayeredProblems = @{}
$joinedListingProblems = @{}
$joinedWithdrawals = @{}
$joinedReportCursors = @{}

function Get-PolicyFilePath([string]$Folder, [string]$NodeId) { return Join-Path $Folder "$NodeId.policy.json" }
function Get-ListRequestPath([string]$Folder, [string]$NodeId) { return Join-Path $Folder "$NodeId.lists.json" }
function Get-ListAnswerPath([string]$Folder, [string]$NodeId) { return Join-Path $Folder "$NodeId.lists.result.json" }

function Test-IsPlainNodeFile([string]$Root) {
    $storage = Join-Path $Root ".storage"
    $file = Join-Path $storage "node.toml"
    if (-not [System.IO.Directory]::Exists($storage) -or (Test-IsReparsePoint $storage)) { return $false }
    return [System.IO.File]::Exists($file) -and -not (Test-IsReparsePoint $file)
}

function Write-NodeFileText([string]$Root, [string]$Text) {
    $file = Join-Path $Root ".storage\node.toml"
    [System.IO.File]::WriteAllText("$file.new", $Text, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::Replace("$file.new", $file, [NullString]::Value)
}

function Get-NodeTablePlacement([string[]]$Lines) {
    $start = $null
    $end = $Lines.Count
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($null -eq $start) { if ($Lines[$index] -match '^\s*\[\s*node\s*\]\s*(#.*)?$') { $start = $index }; continue }
        if ($Lines[$index] -match '^\s*\[') { $end = $index; break }
    }
    return [pscustomobject]@{ start = $start; end = $end }
}

<#
.NOTES
A line edit of the [node] table, so a file that does not parse still loses its apply line and every
other line stays as it was; a value spread over several lines (a multi-line assigned) is one key, read
to the line that closes it.
#>
function Get-NodeTableKeyLines([string[]]$Lines, $Placement) {
    $keys = @()
    if ($null -eq $Placement.start) { return $keys }
    $index = $Placement.start + 1
    while ($index -lt $Placement.end) {
        $line = $Lines[$index]
        if ($line -match '^\s*("?)([A-Za-z0-9_-]+)\1\s*=(.*)$') {
            $name = $Matches[2]; $first = $index; $value = $Matches[3]
            while ((Test-IsOpenArray (Remove-TomlComment $value)) -and $index + 1 -lt $Placement.end) { $index++; $value += " $($Lines[$index])" }
            $keys += [pscustomobject]@{ name = $name; first = $first; last = $index }
        }
        $index++
    }
    return $keys
}

function ConvertTo-TomlText([string]$Text) { return '"' + ($Text -replace '\\', '\\' -replace '"', '\"') + '"' }

function Get-NodePolicyValues($Policy) {
    $assigned = (@($Policy.assigned) | ForEach-Object { ConvertTo-TomlText "$_" }) -join ", "
    return [ordered]@{ threshold = "$([int]$Policy.threshold)"; assigned = "[$assigned]"; access = ConvertTo-TomlText "$($Policy.access)"; apply = "true" }
}

function Read-NodeFileLines([string]$Root) { return @([System.IO.File]::ReadAllText((Join-Path $Root ".storage\node.toml")) -split "`r?`n") }

function ConvertTo-NodeFileText([string[]]$Lines) {
    $text = ($Lines -join "`n").TrimEnd("`n")
    return "$text`n"
}

<#
.NOTES
The threshold, assigned, access and apply lines of [node] replaced where they stand, or added at the end
of the table; identity and every other line kept. Returns $true when it wrote.
#>
function Set-NodeFilePolicy([string]$Root, $Policy) {
    if (-not (Test-IsPlainNodeFile $Root)) { return $false }
    $lines = Read-NodeFileLines $Root
    $placement = Get-NodeTablePlacement $lines
    if ($null -eq $placement.start -or (Test-NodeFileIsArray $lines $placement)) { return $false }
    $keyLines = Get-NodeTableKeyLines $lines $placement
    $values = Get-NodePolicyValues $Policy
    $kept = New-Object System.Collections.Generic.List[string]
    $written = @{}
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($index -ge $placement.start -and $index -lt $placement.end) {
            $key = @($keyLines | Where-Object { $_.first -le $index -and $index -le $_.last }) | Select-Object -First 1
            if ($key -and $values.Contains($key.name)) {
                if ($index -eq $key.first) { $kept.Add("$($key.name) = $($values[$key.name])"); $written[$key.name] = $true }
                continue
            }
        }
        if ($index -eq $placement.end) { foreach ($name in $values.Keys) { if (-not $written.ContainsKey($name)) { $kept.Add("$name = $($values[$name])"); $written[$name] = $true } } }
        $kept.Add($lines[$index])
    }
    foreach ($name in $values.Keys) { if (-not $written.ContainsKey($name)) { $kept.Add("$name = $($values[$name])"); $written[$name] = $true } }
    $text = ConvertTo-NodeFileText $kept.ToArray()
    if ((ConvertTo-NodeFileText $lines) -ceq $text) { return $false }
    Write-NodeFileText $Root $text
    return $true
}

function Test-NodeFileIsArray([string[]]$Lines, $Placement) {
    foreach ($line in @($Lines)) { if ($line -match '^\s*\[\s*array\s*\]') { return $true } }
    foreach ($key in @(Get-NodeTableKeyLines $Lines $Placement)) { if ($key.name -eq "kind" -and $Lines[$key.first] -match 'array') { return $true } }
    return $false
}

<#
.NOTES
Takes the apply key out of [node], whatever its value, every other line kept. The executors read a missing
line as false, so a withdrawal costs at most one run once the node is allowed again.
#>
function Remove-NodeFileApply([string]$Root) {
    if (-not (Test-IsPlainNodeFile $Root)) { return $false }
    $lines = Read-NodeFileLines $Root
    $placement = Get-NodeTablePlacement $lines
    if ($null -eq $placement.start -or (Test-NodeFileIsArray $lines $placement)) { return $false }
    $drop = @(Get-NodeTableKeyLines $lines $placement | Where-Object { $_.name -eq "apply" })
    if ($drop.Count -eq 0) { return $false }
    $kept = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if (@($drop | Where-Object { $_.first -le $index -and $index -le $_.last }).Count -gt 0) { continue }
        $kept.Add($lines[$index])
    }
    Write-NodeFileText $Root (ConvertTo-NodeFileText $kept.ToArray())
    return $true
}

function Read-AgentJson([string]$Path) {
    try { return ConvertFrom-Json ([System.IO.File]::ReadAllText($Path)) } catch { return $null }
}

function Test-IsFreshAgentPolicy($Policy, [string]$NodeId) {
    if (-not $Policy -or $Policy.schema -ne 1 -or $Policy.nodeId -cne $NodeId) { return $false }
    try { $written = [DateTimeOffset]::Parse("$($Policy.writtenAt)", [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds() } catch { return $false }
    $age = (Get-HandoffNow) - $written
    return $age -le $agentPolicyMaxAgeSeconds -and $age -ge -$handoffContractMaxAheadSeconds
}

<#
.NOTES
A Windows node of the stack follows the file its dashboard leaves each round: follow writes the policy,
anything else (no file, an old file, another node's, a withdrawal) takes apply out, the same as a joined
device whose dashboard stops answering.
#>
function Update-NodeFilesFromPolicies([object[]]$Nodes, [string]$Folder) {
    foreach ($node in @($Nodes)) {
        try { Invoke-NodePolicy $node (Read-AgentJson (Get-PolicyFilePath $Folder $node.id)) } catch { Write-WatcherLog "node $($node.id): its node file did not follow its policy: $_" }
    }
}

function Invoke-NodePolicy($Node, $Policy) {
    if ((Test-IsFreshAgentPolicy $Policy $Node.id) -and $Policy.action -eq "follow") {
        if (Set-NodeFilePolicy $Node.root $Policy.policy) { Write-WatcherLog "node $($Node.id): its node file follows the layout, threshold $($Policy.policy.threshold), apply on" }
        return
    }
    if (Remove-NodeFileApply $Node.root) { Write-WatcherLog "node $($Node.id): apply was taken out of its node file" }
}

<#
.NOTES
The folder must already be the one Syncthing has inside the node's root, with no link on the way, and its
.stignore must already ignore the list, or a scan could send it to every keeper as an ordinary file.
#>
function New-HandoffList($Node, [string]$Path) {
    $rootFull = [System.IO.Path]::GetFullPath($Node.root).TrimEnd('\')
    try { $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { return @{ problem = "the folder is not inside the node's root" } }
    if ($full -cne $Path.TrimEnd('\') -or -not (Test-IsInsideFolder $rootFull $full)) { return @{ problem = "the folder is not inside the node's root" } }
    $current = $rootFull
    foreach ($segment in @($full.Substring($rootFull.Length).Trim('\') -split '\\')) {
        $current = Join-Path $current $segment
        if (-not [System.IO.Directory]::Exists($current) -or (Test-IsReparsePoint $current)) { return @{ problem = "the folder does not exist or a link is on its way" } }
    }
    if (-not (Test-FileHasLine (Join-Path $full ".stignore") "/$handoffListName")) { return @{ problem = "the folder's .stignore does not ignore the list yet" } }
    $list = Join-Path $full $handoffListName
    if (Test-HandoffPathExists $list) {
        if ([System.IO.File]::Exists($list) -and -not (Test-IsReparsePoint $list)) { return @{} }
        return @{ problem = "something that is not a regular file is in its place" }
    }
    try { ([System.IO.File]::Open($list, "CreateNew", "ReadWrite", "Read")).Dispose() } catch { return @{ problem = "it could not be created: $($_.Exception.Message)" } }
    return @{}
}

<#
.NOTES
A list the dashboard asked for in a request file; the answer file is what its next reconcile reads to write
the #include. Each round: a folder can vanish between a request and the next round.
#>
function Update-HandoffListRequests([object[]]$Nodes, [string]$Folder) {
    foreach ($node in @($Nodes)) {
        $request = Read-AgentJson (Get-ListRequestPath $Folder $node.id)
        if (-not $request -or $request.schema -ne 1 -or $request.nodeId -cne $node.id -or -not $request.folders) { continue }
        $answers = [ordered]@{}
        foreach ($property in $request.folders.PSObject.Properties) {
            $path = "$($property.Value)"
            $made = New-HandoffList $node $path
            $answers[$property.Name] = $(if ($made.ContainsKey("problem")) { [ordered]@{ path = $path; state = "refused"; problem = $made.problem } } else { [ordered]@{ path = $path; state = "ready" } })
        }
        Write-JsonFile (Get-ListAnswerPath $Folder $node.id) ([ordered]@{ folders = $answers })
    }
}

function Invoke-SyncthingApiBody($Instance, [string]$Method, [string]$Path, $Body) {
    $uri = "http://127.0.0.1:$($Instance.ports.gui)$Path"
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers @{ "X-API-Key" = $Instance.apiKey } -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Body -Depth 12 -Compress))) -TimeoutSec 10 -UseBasicParsing
}

function Test-ModifiedIsQuiet([string]$Modified) {
    try { $at = [DateTimeOffset]::Parse($Modified, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds() } catch { return $false }
    return (Get-HandoffNow) - $at -ge $handoffQuietMinutes * 60
}

function Get-BrowseLevel($Instance, [string]$FolderId, [string]$Prefix) {
    $path = "/rest/db/browse?folder=$(Get-HandoffUri $FolderId)&levels=0"
    if ($Prefix) { $path += "&prefix=$(Get-HandoffUri $Prefix)" }
    return @(Invoke-SyncthingApi $Instance "Get" $path)
}

function Test-ReportBudgetIsSpent([System.Diagnostics.Stopwatch]$Clock) { return $Clock.Elapsed.TotalSeconds -ge $script:joinedReportBudgetSeconds }

function Add-SettledFile($Instance, [string]$FolderId, [string]$Relative, [string]$Modified, $Files) {
    try { $entry = (Get-HandoffFileReport $Instance $FolderId $Relative).local } catch { return }
    if ($entry) { $Files.Add([pscustomobject][ordered]@{ folderId = $FolderId; path = $Relative; modified = $Modified; entry = $entry }) }
}

<#
.NOTES
One directory level per request, so a wide folder costs many small answers instead of one that takes the whole
budget to parse: Invoke-RestMethod on 5.1 parsed a 25 MB answer in 4.4 s (measured). A listing that fails or
that the budget cuts short is said in the report's listingProblems, since a folder too large to list must never
read as empty; what was gathered before the cut is still offered, and the next report goes on from the cursor, so a
folder with more settled files than a report holds is offered in full over many reports.
#>
function Add-FolderFiles($Instance, [string]$FolderId, [System.Diagnostics.Stopwatch]$Clock, $Files, $Problems, [int]$Slice) {
    $directories = New-Object System.Collections.Generic.Queue[string]
    $directories.Enqueue("")
    $cursorKey = "$($Instance.nodeId)|$FolderId"
    $skip = $(if ($script:joinedReportCursors.ContainsKey($cursorKey)) { [int]$script:joinedReportCursors[$cursorKey] } else { 0 })
    $settled = 0
    $added = 0
    while ($directories.Count -gt 0) {
        if ($added -ge $Slice) { $script:joinedReportCursors[$cursorKey] = $settled; return }
        if (Test-ReportBudgetIsSpent $Clock) { $script:joinedReportCursors[$cursorKey] = $settled; $Problems.Add("$FolderId`: the listing ran out of its time with $($directories.Count) directories unread"); return }
        $prefix = $directories.Dequeue()
        try { $entries = Get-BrowseLevel $Instance $FolderId $prefix } catch { $Problems.Add("$FolderId`: it could not be listed: $($_.Exception.Message)"); return }
        foreach ($entry in @($entries | Where-Object { $_ })) {
            if ($added -ge $Slice) { $script:joinedReportCursors[$cursorKey] = $settled; return }
            if (Test-ReportBudgetIsSpent $Clock) { $script:joinedReportCursors[$cursorKey] = $settled; $Problems.Add("$FolderId`: the listing ran out of its time with $($directories.Count) directories unread"); return }
            $relative = $(if ($prefix) { "$prefix/$($entry.name)" } else { "$($entry.name)" })
            if ($entry.type -in @("FILE_INFO_TYPE_DIRECTORY", "directory")) { $directories.Enqueue($relative); continue }
            if ($entry.type -notin @("FILE_INFO_TYPE_FILE", "file") -or -not (Test-ModifiedIsQuiet "$($entry.modTime)")) { continue }
            $settled++
            if ($settled -le $skip) { continue }
            Add-SettledFile $Instance $FolderId $relative "$($entry.modTime)" $Files
            $added++
        }
    }
    $script:joinedReportCursors[$cursorKey] = 0
}

<#
.NOTES
Only send-only folders, the only ones that can hand off, and at most $joinedReportFilesLimit files a report,
shared between the folders, so one folder cannot starve the others.
#>
function Get-ReportFiles($Instance, [object[]]$Folders, [System.Diagnostics.Stopwatch]$Clock, $Problems) {
    $files = New-Object System.Collections.Generic.List[object]
    $sending = @($Folders | Where-Object { $_.type -eq "sendonly" })
    $slice = [math]::Min($joinedReportFilesLimit, [math]::Max(20, [int][math]::Floor($joinedReportFilesLimit / [math]::Max(1, $sending.Count))))
    foreach ($folder in $sending) {
        if ($files.Count -ge $joinedReportFilesLimit) { break }
        Add-FolderFiles $Instance "$($folder.id)" $Clock $files $Problems ([math]::Min($slice, $joinedReportFilesLimit - $files.Count))
    }
    return $files.ToArray()
}

<#
.NOTES
A read past the budget is unknown, as a failed one is, so the dashboard decides unknown and hands nothing off.
#>
function Get-ReportFolder($Instance, $Config, [System.Diagnostics.Stopwatch]$Clock) {
    $ignores = $null
    $status = $null
    if (-not (Test-ReportBudgetIsSpent $Clock)) {
        try {
            $answer = Invoke-SyncthingApi $Instance "Get" "/rest/db/ignores?folder=$(Get-HandoffUri $Config.id)"
            if ($answer.ignore -or -not ($answer.PSObject.Properties["error"] -and $answer.error)) { $ignores = @($answer.ignore | Where-Object { $null -ne $_ }) }
        } catch { }
        try { $status = Invoke-SyncthingApi $Instance "Get" "/rest/db/status?folder=$(Get-HandoffUri $Config.id)" } catch { }
    }
    return [pscustomobject][ordered]@{
        id = "$($Config.id)"; path = "$($Config.path)"; type = "$($Config.type)"; label = "$($Config.label)"; paused = [bool]$Config.paused
        devices = @($Config.devices | ForEach-Object { "$($_.deviceID)" }); versioning = $Config.versioning; ignores = $ignores; status = $status
    }
}

function Get-NodeSpaceReport($Node) {
    try {
        $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Node.root))
        return [pscustomobject][ordered]@{ totalBytes = $drive.TotalSize; freeBytes = $drive.AvailableFreeSpace }
    } catch { return $null }
}

<#
.NOTES
A report covers what Syncthing says now. A read that fails leaves its part out (the dashboard then decides
"unknown", so nothing leaves the node); the whole round is bounded by $joinedReportBudgetSeconds.
#>
function Get-JoinedNodeReport($Instance, $Node, [string]$ResultPath) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $configured = @(Invoke-SyncthingApi $Instance "Get" "/rest/config/folders")
    $known = @(Invoke-SyncthingApi $Instance "Get" "/rest/config/devices" | ForEach-Object { "$($_.deviceID)" })
    $folders = @($configured | ForEach-Object { Get-ReportFolder $Instance $_ $clock })
    $problems = New-Object System.Collections.Generic.List[string]
    return [pscustomobject][ordered]@{
        schema = 1; name = "$($Node.name)"; kind = "$($Node.kind)"; threshold = [int]$Node.threshold; root = "$($Node.root)"; os = "windows"
        deviceId = "$($Instance.deviceId)"; knownDevices = $known; folders = $folders; files = @(Get-ReportFiles $Instance $configured $clock $problems)
        space = Get-NodeSpaceReport $Node; result = $(if ([System.IO.File]::Exists($ResultPath)) { Read-AgentJson $ResultPath } else { $null })
        listingProblems = @($problems)
    }
}

function Test-IsSafeFolderOpPath($Node, [string]$Path) {
    $rootFull = [System.IO.Path]::GetFullPath($Node.root).TrimEnd('\')
    try { $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { return $false }
    if ($full -cne $Path.TrimEnd('\') -or -not (Test-IsInsideFolder $rootFull $full)) { return $false }
    $current = $rootFull
    foreach ($segment in @($full.Substring($rootFull.Length).Trim('\') -split '\\')) {
        $current = Join-Path $current $segment
        if ([System.IO.Directory]::Exists($current) -and (Test-IsReparsePoint $current)) { return $false }
    }
    return $true
}

<#
.NOTES
A new folder's .stignore goes in before Syncthing is told about it, in the reconciler's order (ignored, then
the list created, then the include written), so its first scan never sees the list as an ordinary file.
#>
function Add-JoinedFolder($Instance, $Node, $Op) {
    $path = "$($Op.path)"
    if (-not (Test-IsSafeFolderOpPath $Node $path)) { throw "folder $($Op.id): $path is not a plain path inside the node's root" }
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    Set-NewFolderIgnores $Node $path @($Op.ignores)
    $wanted = Invoke-SyncthingApi $Instance "Get" "/rest/config/defaults/folder"
    $wanted.id = "$($Op.id)"; $wanted.label = "$($Op.label)"; $wanted.path = $path; $wanted.type = "$($Op.type)"
    $wanted.devices = @(@($Op.devices) | ForEach-Object { [pscustomobject]@{ deviceID = "$_" } })
    Invoke-SyncthingApiBody $Instance "Put" "/rest/config/folders/$(Get-HandoffUri $Op.id)" $wanted | Out-Null
}

function Set-NewFolderIgnores($Node, [string]$Path, [string[]]$Lines) {
    $file = Join-Path $Path ".stignore"
    if ([System.IO.File]::Exists($file)) { return }
    $includeLine = "#include $handoffListName"
    $without = @($Lines | Where-Object { $_ -cne $includeLine })
    [System.IO.File]::WriteAllText($file, (($without -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
    $made = New-HandoffList $Node $Path
    if ($made.ContainsKey("problem")) { throw "folder at $Path`: $($made.problem)" }
    [System.IO.File]::WriteAllText($file, (($Lines -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
}

function Invoke-JoinedOp($Instance, $Node, $Op) {
    switch ($Op.op) {
        "type" { Invoke-SyncthingApiBody $Instance "Patch" "/rest/config/folders/$(Get-HandoffUri $Op.folderId)" ([ordered]@{ type = "$($Op.type)" }) | Out-Null }
        "paused" { Invoke-SyncthingApiBody $Instance "Patch" "/rest/config/folders/$(Get-HandoffUri $Op.folderId)" ([ordered]@{ paused = [bool]$Op.paused }) | Out-Null }
        "versioning" { Invoke-SyncthingApiBody $Instance "Patch" "/rest/config/folders/$(Get-HandoffUri $Op.folderId)" ([ordered]@{ versioning = $Op.versioning }) | Out-Null }
        "devices" { Invoke-SyncthingApiBody $Instance "Patch" "/rest/config/folders/$(Get-HandoffUri $Op.folderId)" ([ordered]@{ devices = @(@($Op.devices) | ForEach-Object { [ordered]@{ deviceID = "$_" } }) }) | Out-Null }
        "ignores" { Invoke-SyncthingApiBody $Instance "Post" "/rest/db/ignores?folder=$(Get-HandoffUri $Op.folderId)" ([ordered]@{ ignore = @($Op.lines) }) | Out-Null }
        "ensureList" { Invoke-JoinedEnsureList $Instance $Node $Op }
        "addDevice" { Invoke-SyncthingApiBody $Instance "Put" "/rest/config/devices/$(Get-HandoffUri $Op.deviceId)" ([ordered]@{ deviceID = "$($Op.deviceId)"; name = "$($Op.name)"; addresses = @("dynamic") }) | Out-Null }
        "addFolder" { Add-JoinedFolder $Instance $Node $Op }
        default { throw "unknown change '$($Op.op)'" }
    }
}

function Invoke-JoinedEnsureList($Instance, $Node, $Op) {
    $config = Invoke-SyncthingApi $Instance "Get" "/rest/config/folders/$(Get-HandoffUri $Op.folderId)"
    $made = New-HandoffList $Node "$($config.path)"
    if ($made.ContainsKey("problem")) { throw "folder $($Op.folderId)'s list: $($made.problem)" }
}

function Write-JoinedLayeredProblem($Node, [string]$Problem) {
    $previous = "$($script:joinedLayeredProblems[$Node.id])"
    if ($Problem -eq $previous) { return }
    if ($Problem) { Write-WatcherLog "node $($Node.name) ($($Node.id)): the layered sync's answer: $Problem" }
    $script:joinedLayeredProblems[$Node.id] = $Problem
}

<#
.NOTES
Changes are made in the order the dashboard gave them, which is the reconciler's own; the first that fails
stops the rest, so nothing is ever applied out of order. Only while the dashboard says apply and the node's
own file, followed first, says it too: a move or a write needs both.
#>
function Invoke-JoinedOps($Instance, $Node, $Answer) {
    if ($Answer.apply -ne $true -or (Get-HandoffNodeValue $Node.root "apply") -ne $true) { return }
    foreach ($op in @($Answer.ops | Where-Object { $_ })) {
        try { Invoke-JoinedOp $Instance $Node $op; Write-WatcherLog "node $($Node.id): applied $($op.op) $(if ($op.PSObject.Properties['folderId']) { $op.folderId })" }
        catch { Write-WatcherLog "node $($Node.id): stopped applying its plan at $($op.op): $_"; return }
    }
}

<#
.NOTES
A withdrawal that fails (a lock, a full disk) is kept and retried every round, so one node's failure never costs
another its withdrawal and the node itself does not keep apply past the next round that can write it.
#>
function Invoke-JoinedWithdrawal($Node) {
    try {
        Remove-NodeFileApply $Node.root | Out-Null
        $script:joinedWithdrawals.Remove($Node.id)
    } catch {
        if (-not $script:joinedWithdrawals.ContainsKey($Node.id)) { Write-WatcherLog "node $($Node.id): apply could not be taken out of its node file, retried each round: $_" }
        $script:joinedWithdrawals[$Node.id] = $Node
    }
}

function Set-JoinedNodeFile($Node, $Answer) {
    if ($Answer.nodeFile -and $Answer.nodeFile.action -eq "follow") { $script:joinedWithdrawals.Remove($Node.id); Set-NodeFilePolicy $Node.root $Answer.nodeFile.policy | Out-Null }
    else { Invoke-JoinedWithdrawal $Node }
}

function Write-JoinedListingProblems($Node, $Problems) {
    $text = @($Problems) -join "; "
    if ($text -ceq "$($script:joinedListingProblems[$Node.id])") { return }
    if ($text) { Write-WatcherLog "node $($Node.id): what it reported is incomplete: $text" }
    $script:joinedListingProblems[$Node.id] = $text
}

<#
.NOTES
One node's report, plan and hand-off contract. A dashboard that does not answer takes apply back out of the
node file (any doubt withdraws), and the kept contract ages out by the executor's own limit.
#>
function Update-JoinedNodeLayered($Node, [string]$HandoffFolder, [double]$TimeoutSeconds) {
    $instance = $script:syncthingInstances[$Node.id]
    if (-not $instance -or $instance.state -ne "running" -or -not $instance.deviceId) { return }
    $resultPath = Join-Path $HandoffFolder "$($Node.id).result.json"
    try {
        $report = Get-JoinedNodeReport $instance $Node $resultPath
        Write-JoinedListingProblems $Node $report.listingProblems
        $text = Invoke-DashboardReport $Node.dashboard $Node.id (ConvertTo-Json -InputObject $report -Depth 12 -Compress) $TimeoutSeconds
        $answer = ConvertFrom-Json $text
        if (-not $answer -or $answer.schema -ne 1 -or $answer.nodeId -cne $Node.id) { throw "the answer is not this node's" }
    } catch {
        Invoke-JoinedWithdrawal $Node
        Write-JoinedLayeredProblem $Node "no answer, apply withdrawn until it comes back: $_"
        return
    }
    Write-JoinedLayeredProblem $Node ""
    Set-JoinedNodeFile $Node $answer
    $kept = Join-Path $HandoffFolder "$($Node.id).json"
    if ($answer.contract) { Write-JsonFile $kept $answer.contract }
    elseif ([System.IO.File]::Exists($kept)) { [System.IO.File]::Delete($kept) }
    Invoke-JoinedOps $instance $Node $answer
}

<#
.NOTES
Once a minute, for each joined node whose Syncthing runs, the whole round bounded by $joinedFetchBudgetSeconds
like the connections fetch; a node not asked in time is asked next minute.
#>
function Update-JoinedLayered([object[]]$Nodes) {
    foreach ($id in @($script:joinedWithdrawals.Keys)) { Invoke-JoinedWithdrawal $script:joinedWithdrawals[$id] }
    if (@($Nodes).Count -eq 0 -or ((Get-Now) - $script:lastJoinedLayered).TotalSeconds -lt $joinedLayeredIntervalSeconds) { return }
    if (-not (Test-StackFolderExists)) { return }
    $script:lastJoinedLayered = Get-Now
    $folder = Get-AgentHandoffFolder $script:agentConfig.stackFolder
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    foreach ($node in @($Nodes)) {
        $left = $joinedFetchBudgetSeconds - $clock.Elapsed.TotalSeconds
        if ($left -le 1) { break }
        try { Update-JoinedNodeLayered $node $folder $left }
        catch {
            Write-WatcherLog "node $($node.id): its layered round failed: $_"
            Invoke-JoinedWithdrawal $node
        }
    }
}
