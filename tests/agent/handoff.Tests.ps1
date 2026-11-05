# Pester 3.4: the host agent's hand-off executor (windows/handoff.ps1) on scratch folder nodes in the
# temp folder, against a fake Syncthing that keeps its index in memory. The service, firewall and
# Docker cmdlets are shadowed to throw, so nothing here reaches them, the live agent or a real node.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-handoff-$([guid]::NewGuid())"
$keeperDevice = "KEEPER-DEVICE"
$helloHash = "lZXJ35AHUUjrBoYDZd8zWEt1v/eCpRDGzUiDpBmDPVA="
$global:handoffTestNow = 1793872800

function New-NetFirewallRule { throw "the hand-off tests never call New-NetFirewallRule" }
function Set-NetFirewallRule { throw "the hand-off tests never call Set-NetFirewallRule" }
function Remove-NetFirewallRule { throw "the hand-off tests never call Remove-NetFirewallRule" }
function Remove-ProgramFirewallRules { throw "the hand-off tests never call Remove-ProgramFirewallRules" }
function New-Service { throw "the hand-off tests never call New-Service" }
function Start-Service { throw "the hand-off tests never call Start-Service" }
function Stop-Service { throw "the hand-off tests never call Stop-Service" }
function Get-StackContainers { throw "the hand-off tests never call Get-StackContainers" }

function Get-HandoffNow { return $global:handoffTestNow }

function ConvertFrom-QueryValue([string]$Query, [string]$Name) {
    $match = [regex]::Match($Query, "(?:^|&)$Name=([^&]*)")
    if (-not $match.Success) { return $null }
    return [Uri]::UnescapeDataString($match.Groups[1].Value)
}

function Invoke-SyncthingApi($Instance, [string]$Method, [string]$Path) {
    $global:apiRequests += "$Method $Path"
    $route, $query = $Path -split '\?', 2
    if ($Method -eq "Get" -and $route -like "/rest/config/folders/*") {
        $folder = $global:fakeFolders[[Uri]::UnescapeDataString($route.Substring("/rest/config/folders/".Length))]
        if (-not $folder) { throw "404" }
        return $folder
    }
    if ($Method -eq "Get" -and $route -eq "/rest/db/file") {
        $key = "$(ConvertFrom-QueryValue $query 'folder')|$(ConvertFrom-QueryValue $query 'file')"
        $record = $global:fakeFiles[$key]
        if (-not $record) { throw "404" }
        if ($global:fakeIgnored -contains $key) {
            return [pscustomobject]@{ local = [pscustomobject]@{ size = 0; blocksHash = $null; version = $record.local.version; deleted = $false; ignored = $true; invalid = $true }; global = $record.global; availability = $record.availability }
        }
        return $record
    }
    if ($Method -eq "Post" -and $route -eq "/rest/db/scan") {
        $folderId = ConvertFrom-QueryValue $query 'folder'
        $folderPath = $global:fakeFolders[$folderId].path
        foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $folderPath ".stignore-handoff"))) {
            $global:scans += "$folderId $line $(if (Test-Path -LiteralPath (Join-Path $folderPath $line.TrimStart('/'))) { 'present' } else { 'absent' })"
            if (-not $global:fakeNeverIgnores) { $global:fakeIgnored += "$folderId|$($line.TrimStart('/'))" }
        }
        if ($global:fakeWriteOnScan) { [System.IO.File]::AppendAllText((Join-Path $folderPath $global:fakeWriteOnScan), " written during the scan") }
        return $null
    }
    throw "the fake Syncthing has no $Method $Path"
}

function Set-OldTime([string]$Path, [int64]$Seconds) {
    [System.IO.File]::SetLastWriteTimeUtc($Path, [DateTimeOffset]::FromUnixTimeSeconds($Seconds).UtcDateTime)
}

function Add-TestFile([string]$Relative, [string]$Content) {
    $path = Join-Path $global:folder ($Relative -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
    [System.IO.File]::WriteAllText($path, $Content)
    Set-OldTime $path ($global:handoffTestNow - 3600)
    Set-IndexEntry $Relative $Content.Length
}

function Set-IndexEntry([string]$Relative, [int64]$Size, [string]$Version = "STICK:1", $Availability = @([pscustomobject]@{ id = $keeperDevice; fromTemporary = $false })) {
    $global:fakeFiles["videos|$Relative"] = [pscustomobject]@{
        local = [pscustomobject]@{ size = $Size; numBlocks = 1; blocksHash = $helloHash; version = @($Version); deleted = $false; ignored = $false; invalid = $false }
        global = [pscustomobject]@{ size = $Size; version = @($Version) }
        availability = @($Availability)
    }
}

function New-TestNode([string]$Name) {
    $global:root = Join-Path $scratch $Name
    $global:folder = Join-Path $global:root "Videos"
    New-Item -ItemType Directory -Force -Path (Join-Path $global:root ".storage"), $global:folder | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\node.toml"), "[node]`nid = `"a001`"`nname = `"stick`"`nkind = `"folder`"`nthreshold = 50`napply = true`n")
    [System.IO.File]::WriteAllText((Join-Path $global:folder ".stignore"), "// layered sync begin`n#include .stignore-handoff`n/.stignore-handoff`n// layered sync end`n")
    [System.IO.File]::WriteAllText((Join-Path $global:folder ".stignore-handoff"), "")
    $global:fakeFolders = @{ videos = [pscustomobject]@{ id = "videos"; path = $global:folder; type = "sendonly" } }
    $global:fakeFiles = @{}
    $global:fakeIgnored = @()
    $global:fakeNeverIgnores = $false
    $global:fakeWriteOnScan = $null
    $global:apiRequests = @()
    $global:scans = @()
    $global:handoffTestNow = 1793872800
    $global:instance = [pscustomobject]@{ nodeId = "a001"; node = [pscustomobject]@{ id = "a001"; name = "stick"; kind = "folder"; root = $global:root }; ports = [pscustomobject]@{ gui = 1 }; apiKey = "key"; state = "running" }
    $global:contractPath = Join-Path $scratch "$Name-contract.json"
    $global:resultPath = Join-Path $scratch "$Name-result.json"
    Add-TestFile "clip.mp4" "hello"
}

function New-Entry([string]$Relative, [int64]$Size = 5, [string]$Hash = $helloHash, [string]$FolderPath = $global:folder, [int64]$Modified = ($global:handoffTestNow - 3600)) {
    return [pscustomobject]@{
        folderId = "videos"; folderPath = $FolderPath; path = $Relative; type = "FILE_INFO_TYPE_FILE"; version = @("STICK:1"); size = $Size; numBlocks = 1
        blocksHash = $Hash; modified = "x"; modifiedSeconds = $Modified; keeper = "b002"; keeperDevice = $keeperDevice
    }
}

function Write-Contract([object[]]$Entries, [int64]$WrittenAt = ($global:handoffTestNow - 10), [string]$NodeId = "a001", [bool]$Apply = $true) {
    $contract = [pscustomobject]@{
        schema = 1; nodeId = $NodeId; writtenAt = [DateTimeOffset]::FromUnixTimeSeconds($WrittenAt).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        apply = $Apply; cluster = $false; quietMinutes = 10; entries = @($Entries); waiting = @(); notes = @()
    }
    [System.IO.File]::WriteAllText($global:contractPath, (ConvertTo-Json -InputObject $contract -Depth 10))
}

function Invoke-TestHandoff { Invoke-NodeHandoff $global:instance $global:contractPath $global:resultPath }

function Get-Result { return Get-Content -Raw -LiteralPath $global:resultPath | ConvertFrom-Json }
function Get-Outcome([string]$Relative) { return (@((Get-Result).results | Where-Object { $_.path -eq $Relative }) | ForEach-Object { $_.outcome }) -join "," }
function Get-Reason([string]$Relative) { return (@((Get-Result).results | Where-Object { $_.path -eq $Relative }) | ForEach-Object { $_.reason }) -join "," }
function Test-Present([string]$Relative) { return Test-Path -LiteralPath (Join-Path $global:folder ($Relative -replace '/', '\')) }
function Get-TrashDay { return [DateTimeOffset]::FromUnixTimeSeconds($global:handoffTestNow).UtcDateTime.ToString("yyyy-MM-dd") }
function Get-TrashRoot { return Join-Path $global:root ".storage\handoff-trash" }
function Get-ListedCount([string]$Relative) { return @([System.IO.File]::ReadAllLines((Join-Path $global:folder ".stignore-handoff")) | Where-Object { $_ -ceq "/$Relative" }).Count }

Describe "the hand-off executor" {

    It "moves a confirmed file into the node's trash after its ignore line was written and Syncthing reported it ignored" {
        New-TestNode "confirmed"
        Write-Contract @(New-Entry "clip.mp4")

        Invoke-TestHandoff

        Test-Present "clip.mp4" | Should Be $false
        Get-Outcome "clip.mp4" | Should Be "moved"
        $trashed = Join-Path (Get-TrashRoot) "$(Get-TrashDay)\videos\clip.mp4"
        [System.IO.File]::ReadAllText($trashed) | Should Be "hello"
        Get-ListedCount "clip.mp4" | Should Be 1
        $global:scans | Should Be "videos /clip.mp4 present"
        $manifest = Get-Content -LiteralPath (Join-Path (Get-TrashRoot) "manifest.jsonl") | ConvertFrom-Json
        "$($manifest.trash) $($manifest.size) $($manifest.modifiedSeconds)" | Should Be "$(Get-TrashDay)/videos/clip.mp4 5 $($global:handoffTestNow - 3600)"
        @($global:apiRequests | Where-Object { $_ -notlike "Get *" }) | Should Be "Post /rest/db/scan?folder=videos&sub=clip.mp4"
    }

    It "computes Syncthing's block hash, block by block" {
        $path = Join-Path $scratch "blocks.bin"
        [System.IO.File]::WriteAllText($path, "hello")
        Get-HandoffBlocksHash $path 5 1 | Should Be $helloHash
        [System.IO.File]::WriteAllBytes($path, [byte[]]@())
        Get-HandoffBlocksHash $path 0 1 | Should Be "Xfbg4nYTWdMKgnUFjimfzAOBU0VF9Vz0PkGYP11MlFY="
        Get-HandoffBlockSize 200000 2 | Should Be 131072
        Get-HandoffBlockSize 314572800 1200 | Should Be 262144
        Get-HandoffBlockSize 200000 7 | Should Be $null
    }

    It "leaves a file that is not the confirmed one untouched and unlisted, and goes on with the others" {
        New-TestNode "changed"
        Add-TestFile "grown.mp4" "hello"
        [System.IO.File]::AppendAllText((Join-Path $global:folder "grown.mp4"), " and more")
        Set-OldTime (Join-Path $global:folder "grown.mp4") ($global:handoffTestNow - 3600)
        Add-TestFile "touched.mp4" "hello"
        Set-OldTime (Join-Path $global:folder "touched.mp4") ($global:handoffTestNow - 1800)
        Add-TestFile "rewritten.mp4" "hello"
        [System.IO.File]::WriteAllText((Join-Path $global:folder "rewritten.mp4"), "world")
        Set-OldTime (Join-Path $global:folder "rewritten.mp4") ($global:handoffTestNow - 3600)
        Add-TestFile "fresh.mp4" "hello"
        Set-OldTime (Join-Path $global:folder "fresh.mp4") ($global:handoffTestNow - 60)
        Write-Contract @((New-Entry "grown.mp4"), (New-Entry "touched.mp4"), (New-Entry "rewritten.mp4"), (New-Entry "fresh.mp4" -Modified ($global:handoffTestNow - 60)), (New-Entry "clip.mp4"))

        Invoke-TestHandoff

        foreach ($name in @("grown.mp4", "touched.mp4", "rewritten.mp4", "fresh.mp4")) {
            "$(Test-Present $name) $(Get-ListedCount $name) $(Get-Outcome $name)" | Should Be "True 0 refused"
        }
        Get-Reason "grown.mp4" | Should Be "its size is 14, not the confirmed 5"
        Get-Reason "touched.mp4" | Should Be "it was modified at $($global:handoffTestNow - 1800), not at the confirmed $($global:handoffTestNow - 3600)"
        Get-Reason "rewritten.mp4" | Should Be "its content is not the confirmed content"
        Get-Reason "fresh.mp4" | Should Be "it changed within the last 10 minutes"
        Get-Outcome "clip.mp4" | Should Be "moved"
    }

    It "needs the node's own index to show the confirmed version held by the keeper" {
        New-TestNode "index"
        Add-TestFile "newer.mp4" "hello"
        Set-IndexEntry "newer.mp4" 5 "STICK:2"
        Add-TestFile "unheld.mp4" "hello"
        Set-IndexEntry "unheld.mp4" 5 "STICK:1" @([pscustomobject]@{ id = $keeperDevice; fromTemporary = $true })
        Write-Contract @((New-Entry "newer.mp4"), (New-Entry "unheld.mp4"))

        Invoke-TestHandoff

        "$(Test-Present 'newer.mp4') $(Test-Present 'unheld.mp4') $(Get-ListedCount 'newer.mp4') $(Get-ListedCount 'unheld.mp4')" | Should Be "True True 0 0"
        Get-Reason "newer.mp4" | Should Be "its index entry is not the confirmed version"
        Get-Reason "unheld.mp4" | Should Be "the keeper does not hold the confirmed version, as this node sees it"
    }

    It "waits for a file another process has open" {
        New-TestNode "open"
        Write-Contract @(New-Entry "clip.mp4")
        $holder = [System.IO.File]::Open((Join-Path $global:folder "clip.mp4"), "Open", "Read", "ReadWrite")
        try { Invoke-TestHandoff } finally { $holder.Dispose() }

        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Reason 'clip.mp4')" | Should Be "True 0 it is open"
    }

    It "leaves the file and keeps its line when Syncthing never reports it ignored" {
        New-TestNode "never"
        $global:fakeNeverIgnores = $true
        $script:handoffIgnoreWaitSeconds = 2
        Write-Contract @(New-Entry "clip.mp4")

        Invoke-TestHandoff

        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4')" | Should Be "True 1 ignored-not-moved"
    }

    It "leaves a file written to after its ignore line on the node" {
        New-TestNode "late"
        $global:fakeWriteOnScan = "clip.mp4"
        Write-Contract @(New-Entry "clip.mp4")

        Invoke-TestHandoff

        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4')" | Should Be "True 1 ignored-not-moved"
        Get-Reason "clip.mp4" | Should Be "its size is 29, not the confirmed 5 after its ignore was written; it stays on the node"
    }

    It "acts only inside the node's own root, and never through a link" {
        New-TestNode "paths"
        $outside = Join-Path $scratch "outside"
        New-Item -ItemType Directory -Force -Path $outside | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $outside "secret.mp4"), "hello")
        Set-OldTime (Join-Path $outside "secret.mp4") ($global:handoffTestNow - 3600)
        cmd /c mklink /J (Join-Path $global:folder "linked") $outside | Out-Null
        Set-IndexEntry "linked/secret.mp4" 5
        Write-Contract @((New-Entry "linked/secret.mp4"), (New-Entry "../../outside/secret.mp4"), (New-Entry "star*.mp4"), (New-Entry "back\slash.mp4"), (New-Entry "C:/Windows/win.ini"))

        Invoke-TestHandoff

        foreach ($name in @("linked/secret.mp4", "../../outside/secret.mp4", "star*.mp4", "back\slash.mp4", "C:/Windows/win.ini")) { Get-Outcome $name | Should Be "refused" }
        Test-Path -LiteralPath (Join-Path $outside "secret.mp4") | Should Be $true
        @([System.IO.File]::ReadAllLines((Join-Path $global:folder ".stignore-handoff"))).Count | Should Be 0
        cmd /c rmdir (Join-Path $global:folder "linked") | Out-Null
    }

    It "refuses a folder at another path, outside the root, not send-only, or without the list included" {
        New-TestNode "folders"
        Write-Contract @(New-Entry "clip.mp4" -FolderPath (Join-Path $scratch "elsewhere"))
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-Outcome 'clip.mp4')" | Should Be "True refused"

        $global:fakeFolders.videos.path = $scratch
        Write-Contract @(New-Entry "clip.mp4" -FolderPath $scratch)
        Invoke-TestHandoff
        Get-Reason "clip.mp4" | Should Be "the folder is not inside the node's root"

        New-TestNode "sendreceive"
        $global:fakeFolders.videos.type = "sendreceive"
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-Reason 'clip.mp4')" | Should Be "True the folder is sendreceive here, not send-only"

        New-TestNode "noinclude"
        [System.IO.File]::WriteAllText((Join-Path $global:folder ".stignore"), "// layered sync begin`n// layered sync end`n")
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-Outcome 'clip.mp4') $((Get-Item (Join-Path $global:folder '.stignore-handoff')).Length)" | Should Be "True refused 0"
    }

    It "does nothing at all while the node file does not say apply = true, even with a contract present" {
        foreach ($apply in @("apply = false`n", "")) {
            New-TestNode "report"
            [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\node.toml"), "[node]`nid = `"a001`"`nname = `"stick`"`nkind = `"folder`"`n$apply")
            Write-Contract @(New-Entry "clip.mp4")

            Invoke-TestHandoff

            "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(@($global:apiRequests).Count)" | Should Be "True 0 0"
            (Get-Result).refused | Should Be "the node file does not say apply = true"
        }
    }

    It "refuses a contract whole when it is stale, ahead of the clock, another node's, not in apply mode or unreadable" {
        New-TestNode "stale"
        $cases = @(
            @{ write = { Write-Contract @(New-Entry "clip.mp4") -WrittenAt ($global:handoffTestNow - 410) }; refused = "the contract is 410 s old, more than 300 s" },
            @{ write = { Write-Contract @(New-Entry "clip.mp4") -WrittenAt ($global:handoffTestNow + 90) }; refused = "the contract was written 90 s ahead of this host's clock" },
            @{ write = { Write-Contract @(New-Entry "clip.mp4") -NodeId "a002" }; refused = "the contract names another node" },
            @{ write = { Write-Contract @(New-Entry "clip.mp4") -Apply $false }; refused = "the contract is not in apply mode" },
            @{ write = { [System.IO.File]::WriteAllText($global:contractPath, '{"schema": 1, "nodeId": ') }; refused = "the contract cannot be read" }
        )
        foreach ($case in $cases) {
            & $case.write
            Invoke-TestHandoff
            "$(Test-Present 'clip.mp4') $((Get-Result).refused)" | Should Be "True $($case.refused)"
        }
        @($global:apiRequests).Count | Should Be 0
    }

    It "never hands off from an array, or from a node file of another node" {
        New-TestNode "array"
        [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\node.toml"), "[node]`nid = `"a001`"`nname = `"stick`"`nkind = `"array`"`napply = true`n")
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $((Get-Result).refused)" | Should Be "True an array never hands off"

        [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\node.toml"), "[node]`nid = `"a002`"`nname = `"stick`"`nkind = `"folder`"`napply = true`n")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $((Get-Result).refused)" | Should Be "True the node file is not node a001's"
    }

    It "lets only one run act on a node at a time" {
        New-TestNode "locked"
        Write-Contract @(New-Entry "clip.mp4")
        $lock = [System.IO.File]::Open((Join-Path $global:root ".storage\handoff.lock"), "OpenOrCreate", "ReadWrite", "None")
        try { Invoke-TestHandoff } finally { $lock.Dispose() }

        "$(Test-Present 'clip.mp4') $(@($global:apiRequests).Count) $(Test-Path -LiteralPath $global:resultPath)" | Should Be "True 0 False"
        Test-Path -LiteralPath (Join-Path $global:root ".storage\handoff.lock") -PathType Leaf | Should Be $true
    }

    It "empties only what it moved into the trash, once it is 7 days old" {
        New-TestNode "trash"
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        $day = Join-Path (Get-TrashRoot) "$(Get-TrashDay)\videos"
        [System.IO.File]::WriteAllText((Join-Path (Get-TrashRoot) "foreign.txt"), "not ours")
        [System.IO.File]::WriteAllText((Join-Path $day "foreign.mp4"), "not ours either")
        New-Item -ItemType Directory -Force -Path (Join-Path $day "kept") | Out-Null
        Add-TestFile "second.mp4" "hello"
        Write-Contract @(New-Entry "second.mp4")
        Invoke-TestHandoff
        [System.IO.File]::AppendAllText((Join-Path $day "second.mp4"), "changed")
        $moved = $global:handoffTestNow

        $global:handoffTestNow = $moved + 6 * 86400
        Write-Contract @()
        Invoke-TestHandoff
        "$(Test-Path -LiteralPath (Join-Path $day 'clip.mp4')) $((Get-Result).purged)" | Should Be "True 0"

        $global:handoffTestNow = $moved + 8 * 86400
        Write-Contract @()
        Invoke-TestHandoff
        "$(Test-Path -LiteralPath (Join-Path $day 'clip.mp4')) $((Get-Result).purged)" | Should Be "False 1"
        Test-Path -LiteralPath (Join-Path (Get-TrashRoot) "foreign.txt") | Should Be $true
        Test-Path -LiteralPath (Join-Path $day "foreign.mp4") | Should Be $true
        Test-Path -LiteralPath (Join-Path $day "kept") | Should Be $true
        Test-Path -LiteralPath (Join-Path $day "second.mp4") | Should Be $true
        (Get-Content -LiteralPath (Join-Path (Get-TrashRoot) "manifest.jsonl") | ConvertFrom-Json).path | Should Be "second.mp4"

        Invoke-TestHandoff
        (Get-Result).purged | Should Be 0
    }

    It "never prunes the list and never asks Syncthing to override, revert, delete or reconfigure" {
        New-TestNode "prune"
        [System.IO.File]::WriteAllText((Join-Path $global:folder ".stignore-handoff"), "/kept-from-before.mp4`n/another.mp4`n")
        Write-Contract @(New-Entry "clip.mp4")

        Invoke-TestHandoff

        ([System.IO.File]::ReadAllLines((Join-Path $global:folder ".stignore-handoff")) -join " ") | Should Be "/kept-from-before.mp4 /another.mp4 /clip.mp4"
        @($global:apiRequests | Where-Object { $_ -match 'override|revert|Delete|Put |Patch |/rest/system' }).Count | Should Be 0
    }
}

Describe "the stack round runs the executor" {
    It "once a minute, for each running node with a contract" {
        $stack = Join-Path $scratch "stack"
        New-Item -ItemType Directory -Force -Path (Get-AgentHandoffFolder $stack) | Out-Null
        [System.IO.File]::WriteAllText((Join-Path (Get-AgentHandoffFolder $stack) "a001.json"), "{}")
        $script:agentConfig = [pscustomobject]@{ stackFolder = $stack }
        $script:syncthingInstances = @{
            a001 = [pscustomobject]@{ nodeId = "a001"; state = "running"; node = [pscustomobject]@{ id = "a001" } }
            b002 = [pscustomobject]@{ nodeId = "b002"; state = "running"; node = [pscustomobject]@{ id = "b002" } }
            c003 = [pscustomobject]@{ nodeId = "c003"; state = "stopped"; node = [pscustomobject]@{ id = "c003" } }
        }
        [System.IO.File]::WriteAllText((Join-Path (Get-AgentHandoffFolder $stack) "c003.json"), "{}")
        $global:handoffRuns = @()
        function Invoke-NodeHandoff($Instance, [string]$ContractPath, [string]$ResultPath) { $global:handoffRuns += "$($Instance.nodeId) $(Split-Path -Leaf $ContractPath) $(Split-Path -Leaf $ResultPath)" }
        $script:lastHandoffRound = [datetime]::MinValue

        Invoke-HandoffRound
        Invoke-HandoffRound

        $global:handoffRuns | Should Be "a001 a001.json a001.result.json"
    }
}

Remove-Item -Recurse -Force -LiteralPath $scratch -ErrorAction SilentlyContinue
