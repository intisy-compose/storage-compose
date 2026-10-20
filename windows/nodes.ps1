# Finding drive and folder nodes on Windows volumes (specs/2026-10-20-connect-devices-design.md, the
# node file). Only two files at a volume's root are ever read; nothing below a root is searched.
# Dot-sourced by the agent; defines functions only.

$nodeIdPattern = '^[0-9a-f]{4}$'
$nodeNamePattern = '^[a-z0-9-]+$'
$nativeNodeKinds = @("drive", "folder")

function ConvertFrom-TomlString([string]$Text) {
    if ($Text.StartsWith("'")) { return $Text.Substring(1, $Text.Length - 2) }
    $inner = $Text.Substring(1, $Text.Length - 2)
    return [regex]::Replace($inner, '\\(["\\nt])', { param($match) switch ($match.Groups[1].Value) { "n" { "`n" } "t" { "`t" } default { $match.Groups[1].Value } } })
}

function Remove-TomlComment([string]$Line) {
    $quote = $null
    for ($index = 0; $index -lt $Line.Length; $index++) {
        $character = $Line[$index]
        if ($quote) {
            if ($character -eq '\' -and $quote -eq '"') { $index++; continue }
            if ($character -eq $quote) { $quote = $null }
            continue
        }
        if ($character -eq '"' -or $character -eq "'") { $quote = $character; continue }
        if ($character -eq '#') { return $Line.Substring(0, $index) }
    }
    return $Line
}

function ConvertFrom-TomlValue([string]$Text) {
    $value = $Text.Trim()
    if ($value -match '^\[(.*)\]$') {
        $items = [regex]::Matches($Matches[1], '"(?:[^"\\]|\\.)*"|''[^'']*''|[^,\s]+')
        return , @($items | ForEach-Object { ConvertFrom-TomlValue $_.Value })
    }
    if ($value -match '^(".*"|''.*'')$') { return ConvertFrom-TomlString $value }
    if ($value -eq "true") { return $true }
    if ($value -eq "false") { return $false }
    if ($value -match '^[+-]?\d+$') { return [int64]$value }
    throw "unsupported value: $value"
}

function Test-IsOpenArray([string]$Text) {
    return ([regex]::Matches($Text, '\[').Count - [regex]::Matches($Text, '\]').Count) -gt 0
}

<#
.NOTES
Only what node files use: tables, keys with strings, integers, booleans and (multi-line) arrays of
those. Arrays of tables ([[array.members]]) are skipped, since a native node is never an array.
#>
function ConvertFrom-SimpleToml([string]$Text) {
    $document = @{ "" = @{} }
    $section = ""
    $pending = $null
    foreach ($rawLine in ($Text -split "`r?`n")) {
        $line = (Remove-TomlComment $rawLine).Trim()
        if ($pending) {
            $pending.Value += " $line"
            if (Test-IsOpenArray $pending.Value) { continue }
            if ($section -ne $null) { $document[$section][$pending.Key] = ConvertFrom-TomlValue $pending.Value }
            $pending = $null
            continue
        }
        if (-not $line) { continue }
        if ($line -match '^\[\[.*\]\]$') { $section = $null; continue }
        if ($line -match '^\[\s*([A-Za-z0-9_.-]+)\s*\]$') {
            $section = $Matches[1]
            if (-not $document.ContainsKey($section)) { $document[$section] = @{} }
            continue
        }
        if ($line -notmatch '^([A-Za-z0-9_-]+)\s*=\s*(.*)$') { throw "cannot read line: $rawLine" }
        $key = $Matches[1]
        $value = $Matches[2]
        if (Test-IsOpenArray $value) { $pending = @{ Key = $key; Value = $value }; continue }
        if ($section -ne $null) { $document[$section][$key] = ConvertFrom-TomlValue $value }
    }
    return $document
}

function Read-TomlFile([string]$Path) {
    return ConvertFrom-SimpleToml ([System.IO.File]::ReadAllText($Path))
}

function Get-NodeFilePath([string]$Folder) { return [System.IO.Path]::Combine($Folder, ".storage\node.toml") }

function Get-NodeIndexPath([string]$VolumeRoot) { return [System.IO.Path]::Combine($VolumeRoot, ".storage\nodes.toml") }

function Read-NodeFile([string]$Folder) {
    $table = (Read-TomlFile (Get-NodeFilePath $Folder))["node"]
    if (-not $table) { throw "it has no [node] table" }
    $node = [pscustomobject]@{
        id = "$($table['id'])"; name = "$($table['name'])"; kind = "$($table['kind'])"
        threshold = 0; assigned = @(); root = $Folder
    }
    if ($table.ContainsKey("threshold")) { $node.threshold = [int]$table["threshold"] }
    if ($table.ContainsKey("assigned")) { $node.assigned = @($table["assigned"]) }
    if ($node.id -cnotmatch $nodeIdPattern) { throw "id '$($node.id)' is not 4 lowercase hex digits" }
    if ($node.name -cnotmatch $nodeNamePattern) { throw "name '$($node.name)' must be lowercase letters, digits and hyphens" }
    return $node
}

function Test-IsSafeRelativePath([string]$Path) {
    if (-not $Path -or [System.IO.Path]::IsPathRooted($Path)) { return $false }
    return @($Path -split '[\\/]' | Where-Object { $_ -in @("", ".", "..") }).Count -eq 0
}

function New-NodeProblem([string]$Path, [string]$Message) { return "$Path`: $Message" }

<#
.NOTES
A folder node inside a drive node would be synced twice, so a volume that is a drive node has its
index ignored (the layered sync's rule: a node is never nested in another).
#>
function Find-VolumeNodes([string]$VolumeRoot) {
    $result = [pscustomobject]@{ nodes = @(); problems = @() }
    $isDriveNode = Test-Path -LiteralPath (Get-NodeFilePath $VolumeRoot)
    if ($isDriveNode) {
        try {
            $node = Read-NodeFile $VolumeRoot
            if ($node.kind -eq "drive") { $result.nodes += $node }
            else { $result.problems += New-NodeProblem (Get-NodeFilePath $VolumeRoot) "kind '$($node.kind)' at a volume root; only a drive node is the volume itself" }
        } catch { $result.problems += New-NodeProblem (Get-NodeFilePath $VolumeRoot) "$_" }
    }
    $index = Get-NodeIndexPath $VolumeRoot
    if (-not (Test-Path -LiteralPath $index)) { return $result }
    if ($isDriveNode) { $result.problems += New-NodeProblem $index "ignored: the volume is a drive node, and nodes are never nested"; return $result }
    try { $paths = @((Read-TomlFile $index)[""]["paths"]) } catch { $result.problems += New-NodeProblem $index "$_"; return $result }
    foreach ($relative in $paths | Where-Object { $_ }) {
        if (-not (Test-IsSafeRelativePath "$relative")) { $result.problems += New-NodeProblem $index "path '$relative' must stay below the volume root"; continue }
        $folder = [System.IO.Path]::Combine($VolumeRoot, "$relative")
        $nodeFile = Get-NodeFilePath $folder
        if (-not (Test-Path -LiteralPath $nodeFile)) { $result.problems += New-NodeProblem $nodeFile "listed in the index but missing"; continue }
        try {
            $node = Read-NodeFile $folder
            if ($node.kind -eq "folder") { $result.nodes += $node }
            else { $result.problems += New-NodeProblem $nodeFile "kind '$($node.kind)' listed as a folder node" }
        } catch { $result.problems += New-NodeProblem $nodeFile "$_" }
    }
    return $result
}

function Get-VolumeRoots {
    return @(Get-Volume -ErrorAction SilentlyContinue |
        Where-Object { $_.DriveLetter -and $_.DriveType -in @("Fixed", "Removable") -and $_.OperationalStatus -eq "OK" } |
        ForEach-Object { "$($_.DriveLetter):\" } | Sort-Object)
}

function Find-Nodes([string[]]$VolumeRoots) {
    $found = [pscustomobject]@{ nodes = @(); problems = @() }
    $seen = @{}
    foreach ($root in $VolumeRoots) {
        $volume = Find-VolumeNodes $root
        $found.problems += $volume.problems
        foreach ($node in $volume.nodes) {
            if ($seen.ContainsKey($node.id)) {
                $found.problems += New-NodeProblem $node.root "node $($node.id) is also at $($seen[$node.id]); only the first one runs"
                continue
            }
            $seen[$node.id] = $node.root
            $found.nodes += $node
        }
    }
    return $found
}
