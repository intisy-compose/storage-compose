# Pester 3.4: reading node files and finding drive and folder nodes, on temporary folders standing in
# for volume roots.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\nodes.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-nodes-$([guid]::NewGuid())"

function New-Volume([string]$Name) {
    $root = Join-Path $scratch $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $root ".storage") | Out-Null
    return $root
}

function Write-Text([string]$Path, [string]$Text) {
    New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text)
}

function Write-NodeFile([string]$Folder, [string]$Id, [string]$Name, [string]$Kind, [int]$Threshold = 0) {
    Write-Text (Join-Path $Folder ".storage\node.toml") "[node]`nid        = `"$Id`"`nname      = `"$Name`" # a comment`nkind      = `"$Kind`"`nthreshold = $Threshold`nassigned  = [`"Documents/GitHub`", `"Pictures`"]`n"
}

Describe "the node file reader" {
    It "reads the contract's example, array tables included" {
        $text = @'
[node]
id        = "a3f9"          # 4 lowercase hex, random at creation, never changes
name      = "private-array" # unique per network, [a-z0-9-]
kind      = "array"         # array | drive | folder
threshold = 0               # layered sync: 0 keeps everything
assigned  = []              # directories kept regardless of priority

# arrays only: the whole membership on every member, newest `revision` wins
[array]
revision = 7
[[array.members]]
role   = "data1"            # dataN | parityN
label  = "a3f9-data1"       # ext4 label, at most 16 characters
serial = "ZA2..."
size   = 4000787030016
asset  = "SAM-0056"         # optional note
'@
        $document = ConvertFrom-SimpleToml $text
        $document["node"]["id"] | Should Be "a3f9"
        $document["node"]["name"] | Should Be "private-array"
        $document["node"]["threshold"] | Should Be 0
        @($document["node"]["assigned"]).Count | Should Be 0
        $document["array"]["revision"] | Should Be 7
        $document["array"].ContainsKey("role") | Should Be $false
    }

    It "reads a multi-line array, literal strings and a # inside a string" {
        $document = ConvertFrom-SimpleToml "paths = [`n  'files',`n  `"Games # old`",`n]`n"
        $document[""]["paths"] | Should Be @("files", "Games # old")
    }

    It "refuses a line it cannot read" {
        { ConvertFrom-SimpleToml "this is not toml" } | Should Throw
    }
}

Describe "finding nodes" {
    BeforeEach { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch }
    AfterEach { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch }

    It "finds a drive node at a volume root" {
        $root = New-Volume "F"
        Write-NodeFile $root "b7c2" "pc" "drive" 80
        $found = Find-Nodes @($root)
        @($found.nodes).Count | Should Be 1
        $found.nodes[0].id | Should Be "b7c2"
        $found.nodes[0].kind | Should Be "drive"
        $found.nodes[0].threshold | Should Be 80
        $found.nodes[0].root | Should Be $root
        $found.nodes[0].assigned | Should Be @("Documents/GitHub", "Pictures")
        @($found.problems).Count | Should Be 0
    }

    It "finds the folder nodes a volume's index lists, and only those" {
        $root = New-Volume "D"
        Write-Text (Join-Path $root ".storage\nodes.toml") "paths = [`"files`"]`n"
        Write-NodeFile (Join-Path $root "files") "c001" "ventoy-files" "folder" 80
        Write-NodeFile (Join-Path $root "other") "c002" "not-listed" "folder"
        Write-NodeFile (Join-Path $root "files\deeper") "c003" "nested-unlisted" "folder"
        $found = Find-Nodes @($root)
        @($found.nodes | ForEach-Object { $_.id }) | Should Be @("c001")
        $found.nodes[0].root | Should Be (Join-Path $root "files")
    }

    It "never looks below a volume root without an index" {
        $root = New-Volume "E"
        Write-NodeFile (Join-Path $root "files") "c004" "unregistered" "folder"
        @((Find-Nodes @($root)).nodes).Count | Should Be 0
    }

    It "ignores a folder index on a volume that is a drive node, since nodes never nest" {
        $root = New-Volume "G"
        Write-NodeFile $root "d001" "drive" "drive"
        Write-Text (Join-Path $root ".storage\nodes.toml") "paths = [`"files`"]`n"
        Write-NodeFile (Join-Path $root "files") "d002" "inner" "folder"
        $found = Find-Nodes @($root)
        @($found.nodes | ForEach-Object { $_.id }) | Should Be @("d001")
        "$($found.problems)" | Should Match "never nested"
    }

    It "reports a listed folder without its node file, a path leaving the root and a wrong kind" {
        $root = New-Volume "H"
        Write-Text (Join-Path $root ".storage\nodes.toml") "paths = [`"missing`", `"..\\outside`", `"wrongkind`"]`n"
        Write-NodeFile (Join-Path $root "wrongkind") "e001" "wrong" "drive"
        $found = Find-Nodes @($root)
        @($found.nodes).Count | Should Be 0
        @($found.problems).Count | Should Be 3
    }

    It "refuses an array node file at a volume root" {
        $root = New-Volume "I"
        Write-NodeFile $root "f001" "array" "array"
        $found = Find-Nodes @($root)
        @($found.nodes).Count | Should Be 0
        "$($found.problems)" | Should Match "only a drive node"
    }

    It "refuses an id or a name outside the contract" {
        $root = New-Volume "J"
        Write-NodeFile $root "A3F9" "pc" "drive"
        $other = New-Volume "K"
        Write-NodeFile $other "a3f9" "PC Name" "drive"
        $found = Find-Nodes @($root, $other)
        @($found.nodes).Count | Should Be 0
        @($found.problems).Count | Should Be 2
    }

    It "runs a node seen on two volumes once" {
        $first = New-Volume "L"
        Write-NodeFile $first "abcd" "copy" "drive"
        $second = New-Volume "M"
        Write-NodeFile $second "abcd" "copy" "drive"
        $found = Find-Nodes @($first, $second)
        @($found.nodes).Count | Should Be 1
        $found.nodes[0].root | Should Be $first
        "$($found.problems)" | Should Match "only the first one runs"
    }
}
