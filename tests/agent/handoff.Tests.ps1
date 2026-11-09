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

$handoffIgnoreWaitSeconds = 2

function Invoke-SyncthingApi($Instance, [string]$Method, [string]$Path) {
    $global:apiRequests += "$Method $Path"
    if ($global:replaceContractWith) { [System.IO.File]::WriteAllText($global:contractPath, $global:replaceContractWith); $global:replaceContractWith = $null }
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
    if ($Method -eq "Get" -and $route -eq "/rest/system/connections") { return $global:fakeConnections }
    if ($Method -eq "Post" -and $route -eq "/rest/db/scan") {
        $folderId = ConvertFrom-QueryValue $query 'folder'
        $folderPath = $global:fakeFolders[$folderId].path
        if (-not $global:fakeNeverIgnores) { $global:fakeIgnored = @($global:fakeIgnored | Where-Object { -not $_.StartsWith("$folderId|") }) }
        foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $folderPath ".stignore-handoff"))) {
            $global:scans += "$folderId $line $(if (Test-Path -LiteralPath (Join-Path $folderPath $line.TrimStart('/'))) { 'present' } else { 'absent' })"
            if (-not $global:fakeNeverIgnores) { $global:fakeIgnored += "$folderId|$($line.TrimStart('/'))" }
        }
        if ($global:fakeWriteOnScan) { [System.IO.File]::AppendAllText((Join-Path $folderPath $global:fakeWriteOnScan), " written during the scan") }
        return $null
    }
    throw "the fake Syncthing has no $Method $Path"
}

$realMetadataDifference = (Get-Item function:\Get-HandoffMetadataDifference).ScriptBlock
function Get-HandoffMetadataDifference([string]$Folder, $Entry) {
    if ($Entry.path -eq "boom.mp4") { throw "a failure on this path alone" }
    return & $realMetadataDifference $Folder $Entry
}

$realMoveHandoffFile = (Get-Item function:\Move-HandoffFile).ScriptBlock
function Move-HandoffFile([string]$Source, [string]$Target) {
    if ($global:moveRefuses) { return $false }
    if ($Source -like "*\handoff-trash\*" -and $global:moveBackFails) { return $false }
    $moved = & $realMoveHandoffFile $Source $Target
    if ($moved -and $global:moveGrows -and $Target -like "*\handoff-trash\*") {
        [System.IO.File]::AppendAllText($Target, " grown")
        Set-OldTime $Target ($global:handoffTestNow - 3600)
    }
    return $moved
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
    $global:replaceContractWith = $null
    $global:fakeConnections = [pscustomobject]@{ connections = [pscustomobject]@{ $keeperDevice = [pscustomobject]@{ connected = $true } } }
    $global:moveRefuses = $false
    $global:moveBackFails = $false
    $global:moveGrows = $false
    $script:handoffPendingAttempts = 10
    $script:handoffHashStopping = @()
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

function Wait-HashJobs {
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and @($script:handoffHashJobs.Values | Where-Object { -not $_.handle.IsCompleted }).Count -gt 0) { Start-Sleep -Milliseconds 100 }
}

function Get-Result { return Get-Content -Raw -LiteralPath $global:resultPath | ConvertFrom-Json }
function Get-Outcome([string]$Relative) { return (@((Get-Result).results | Where-Object { $_.path -eq $Relative }) | ForEach-Object { $_.outcome }) -join "," }
function Get-Reason([string]$Relative) { return (@((Get-Result).results | Where-Object { $_.path -eq $Relative }) | ForEach-Object { $_.reason }) -join "," }
function Test-Present([string]$Relative) { return Test-Path -LiteralPath (Join-Path $global:folder ($Relative -replace '/', '\')) }
function Get-TrashDay { return [DateTimeOffset]::FromUnixTimeSeconds($global:handoffTestNow).UtcDateTime.ToString("yyyy-MM-dd") }
function Get-TrashRoot { return Join-Path $global:root ".storage\handoff-trash" }
function Get-PendingPaths { return (@(Read-HandoffLines (Join-Path $global:root ".storage\handoff-pending.jsonl")) | ForEach-Object { $_.path }) -join " " }
function Get-TrashKept { return (@((Get-Result).trash) | ForEach-Object { "$($_.trash): $($_.reason)" }) -join "|" }
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

        foreach ($name in @("grown.mp4", "touched.mp4", "fresh.mp4", "rewritten.mp4")) {
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

    It "keeps a path Syncthing never reported ignored pending, and moves it on a later run without a contract entry" {
        New-TestNode "never"
        $global:fakeNeverIgnores = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4') $(Get-PendingPaths)" | Should Be "True 1 ignored-not-moved clip.mp4"

        $global:fakeNeverIgnores = $false
        Write-Contract @()
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4') [$(Get-PendingPaths)]" | Should Be "False 1 moved []"
    }

    It "releases a pending path once its retries run out, and one changed before its retry" {
        New-TestNode "abandoned"
        $global:fakeNeverIgnores = $true
        $script:handoffPendingAttempts = 2
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        Write-Contract @()
        Invoke-TestHandoff
        "$(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4')" | Should Be "1 ignored-not-moved"
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4') [$(Get-PendingPaths)]" | Should Be "True 0 released []"

        New-TestNode "retrychanged"
        $global:fakeNeverIgnores = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        [System.IO.File]::WriteAllText((Join-Path $global:folder "clip.mp4"), "hello again")
        Write-Contract @()
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4') [$(Get-PendingPaths)]" | Should Be "True 0 released []"
    }

    It "never removes a moved path's line, and reports a newer file at that path" {
        New-TestNode "movedline"
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        Add-TestFile "clip.mp4" "new content"
        Set-OldTime (Join-Path $global:folder "clip.mp4") ($global:handoffTestNow + 60)
        Add-HandoffLine (Join-Path $global:root ".storage\handoff-pending.jsonl") ([ordered]@{ folderId = "videos"; folderPath = $global:folder; path = "clip.mp4"; entry = (New-Entry "clip.mp4"); since = 0; attempts = 0 })
        $global:handoffTestNow += 700
        Write-Contract @()
        Invoke-TestHandoff
        "$(Get-ListedCount 'clip.mp4') $(@((Get-Result).results | Where-Object { $_.path -eq 'clip.mp4' })[0].outcome)" | Should Be "1 ignored-not-moved"

        [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\handoff-pending.jsonl"), "")
        Invoke-TestHandoff
        "$(Get-Outcome 'clip.mp4') $(Get-ListedCount 'clip.mp4')" | Should Be "unsynced-at-handed-off-path 1"
    }

    It "removes the line again of a file written to after it, so the edit reaches the keepers" {
        New-TestNode "late"
        $global:fakeWriteOnScan = "clip.mp4"
        Write-Contract @(New-Entry "clip.mp4")

        Invoke-TestHandoff

        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4') [$(Get-PendingPaths)]" | Should Be "True 0 released []"
        Get-Reason "clip.mp4" | Should Be "its size is 29, not the confirmed 5 after its ignore was written; its ignore line was removed, so it syncs again"
        @($global:apiRequests | Where-Object { $_ -eq "Post /rest/db/scan?folder=videos&sub=clip.mp4" }).Count | Should Be 2
    }

    It "puts back a file that changed while it was renamed, and reports one it cannot put back" {
        New-TestNode "putback"
        $global:moveGrows = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-Outcome 'clip.mp4')" | Should Be "True 0 released"

        New-TestNode "stuck"
        $global:moveGrows = $true
        $global:moveBackFails = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-Outcome 'clip.mp4') $(@((Get-Result).results)[0].trash)" | Should Be "False in-trash-unlisted $(Get-TrashDay)/videos/clip.mp4"
        @((Get-Result).trash).Count | Should Be 1
        $global:handoffTestNow += 8 * 86400
        Write-Contract @()
        Invoke-TestHandoff
        "$(Test-Path -LiteralPath (Join-Path (Get-TrashRoot) "$([DateTimeOffset]::FromUnixTimeSeconds($global:handoffTestNow - 8 * 86400).UtcDateTime.ToString('yyyy-MM-dd'))\videos\clip.mp4")) $((Get-Result).purged)" | Should Be "True 0"
    }

    It "keeps a file pending when the rename fails, never copying it" {
        New-TestNode "refusedmove"
        $global:moveRefuses = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Get-Outcome 'clip.mp4') $(Get-PendingPaths)" | Should Be "True ignored-not-moved clip.mp4"
        Test-Path -LiteralPath (Join-Path (Get-TrashRoot) "$(Get-TrashDay)\videos\clip.mp4") | Should Be $false
    }

    It "acts on the contract it read even when the file is replaced mid-run" {
        New-TestNode "replaced"
        Add-TestFile "other.mp4" "hello"
        Write-Contract @(New-Entry "other.mp4")
        $global:replaceContractWith = [System.IO.File]::ReadAllText($global:contractPath)
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Test-Present 'other.mp4') $(Get-Outcome 'clip.mp4') [$(Get-Outcome 'other.mp4')]" | Should Be "False True moved []"
    }

    It "keeps going after one path fails, and still writes a result" {
        New-TestNode "isolated"
        Add-TestFile "boom.mp4" "hello"
        Write-Contract @((New-Entry "boom.mp4"), (New-Entry "clip.mp4"))
        Invoke-TestHandoff
        "$(Get-Outcome 'boom.mp4') $(Get-Outcome 'clip.mp4')" | Should Be "refused moved"
        Get-Reason "boom.mp4" | Should Be "the executor failed on it: a failure on this path alone"
    }

    It "hashes before the ignore, and goes on with a file the round's deadline cut short in the background, leaving no trace on the node" {
        New-TestNode "budget"
        $check = Get-HandoffContentCheck $global:folder (New-Entry "clip.mp4") ([datetime]::MinValue)
        $check.ContainsKey("budget") | Should Be $true
        $script:handoffRunSeconds = 0
        try {
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            "$(Get-Outcome 'clip.mp4') $(Get-ListedCount 'clip.mp4') [$(Get-PendingPaths)]" | Should Be "deferred 0 []"
            $script:handoffHashJobs.Count | Should Be 1
        } finally { $script:handoffRunSeconds = 20 }
        Wait-HashJobs
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        "$(Get-Outcome 'clip.mp4') $($script:handoffHashJobs.Count)" | Should Be "moved 0"
    }

    It "refuses a file a background hash found to be other content, and never hashes one file twice at once" {
        New-TestNode "backgroundother"
        [System.IO.File]::WriteAllText((Join-Path $global:folder "clip.mp4"), "other")
        Set-OldTime (Join-Path $global:folder "clip.mp4") ($global:handoffTestNow - 3600)
        $script:handoffRunSeconds = 0
        try {
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            Wait-HashJobs
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            "$(Get-Outcome 'clip.mp4') $(Get-ListedCount 'clip.mp4') $($script:handoffHashJobs.Count)" | Should Be "refused 0 0"
            Get-Reason "clip.mp4" | Should Be "its content is not the confirmed content"
        } finally { $script:handoffRunSeconds = 20 }
    }

    It "reads a large file sharing it with other readers, while writers stay out" {
        New-TestNode "sharing"
        $path = Join-Path $global:folder "clip.mp4"
        $reader = [System.IO.File]::Open($path, "Open", "Read", "ReadWrite")
        try { $stream = Open-HandoffHashStream $path } finally { $reader.Dispose() }
        try { { [System.IO.File]::Open($path, "Open", "Write", "ReadWrite") } | Should Throw } finally { $stream.Dispose() }
    }

    It "still counts a reader as open before it ignores a file hashed in the background" {
        New-TestNode "backgroundopen"
        $script:handoffRunSeconds = 0
        try {
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            Wait-HashJobs
            $reader = [System.IO.File]::Open((Join-Path $global:folder "clip.mp4"), "Open", "Read", "ReadWrite")
            try { Write-Contract @(New-Entry "clip.mp4"); Invoke-TestHandoff } finally { $reader.Dispose() }
            "$(Get-Outcome 'clip.mp4') $(Get-ListedCount 'clip.mp4')" | Should Be "refused 0"
            Get-Reason "clip.mp4" | Should Be "it is open"
        } finally { $script:handoffRunSeconds = 20; Stop-HandoffHashJobs }
    }

    function New-StallingHashJob([string]$Key) {
        $space = [runspacefactory]::CreateRunspace()
        $space.Open()
        $shell = [powershell]::Create()
        $shell.Runspace = $space
        [void]$shell.AddScript("[System.Threading.Thread]::Sleep(8000)")
        $script:handoffHashJobs[$Key] = [pscustomobject]@{ shell = $shell; space = $space; handle = $shell.BeginInvoke(); startedAt = Get-Date; path = (Join-Path $global:folder "clip.mp4"); size = 5; modifiedSeconds = $global:handoffTestNow - 3600 }
    }
    function Get-TestHashKey { return "$([System.IO.Path]::GetFullPath($global:root))|videos|clip.mp4|STICK:1|5|$($global:handoffTestNow - 3600)" }

    It "gives up on a hash still running past its limit, without waiting for the disk" {
        New-TestNode "timeout"
        New-StallingHashJob (Get-TestHashKey)
        $script:handoffHashJobSeconds = 0
        try {
            Write-Contract @(New-Entry "clip.mp4")
            $clock = [System.Diagnostics.Stopwatch]::StartNew()
            Invoke-TestHandoff
            $clock.Elapsed.TotalSeconds | Should BeLessThan 5
            "$(Get-Outcome 'clip.mp4') $($script:handoffHashJobs.Count)" | Should Be "refused 0"
            Get-Reason "clip.mp4" | Should Match "took longer than"
        } finally { $script:handoffHashJobSeconds = 21600; $script:handoffHashGaveUp = @{} }
    }

    It "takes a finished hash whatever its age, and does not give up on it" {
        New-TestNode "latefinish"
        $script:handoffRunSeconds = 0
        $script:handoffHashJobSeconds = 0
        try {
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            Wait-HashJobs
            $script:handoffRunSeconds = 20
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            "$(Get-Outcome 'clip.mp4') $($script:handoffHashGaveUp.Count)" | Should Be "moved 0"
        } finally { $script:handoffRunSeconds = 20; $script:handoffHashJobSeconds = 21600; $script:handoffHashGaveUp = @{}; Stop-HandoffHashJobs }
    }

    It "keeps a background hash through any number of rounds without its entry, while the file is the one it reads" {
        New-TestNode "keptjob"
        New-StallingHashJob (Get-TestHashKey)
        try {
            foreach ($round in 1..7) { Write-Contract @(); Invoke-TestHandoff }
            $script:handoffHashJobs.Count | Should Be 1
        } finally { Stop-HandoffHashJobs }
    }

    It "stops a background hash out of the contract once its file changed or is gone" {
        New-TestNode "changedjob"
        New-StallingHashJob (Get-TestHashKey)
        try {
            Set-OldTime (Join-Path $global:folder "clip.mp4") ($global:handoffTestNow - 100)
            Write-Contract @()
            Invoke-TestHandoff
            $script:handoffHashJobs.Count | Should Be 0
        } finally { Stop-HandoffHashJobs }
        New-TestNode "gonejob"
        New-StallingHashJob (Get-TestHashKey)
        try {
            Remove-Item -LiteralPath (Join-Path $global:folder "clip.mp4")
            Write-Contract @()
            Invoke-TestHandoff
            $script:handoffHashJobs.Count | Should Be 0
        } finally { Stop-HandoffHashJobs }
    }

    It "stops a background hash out of the contract at its limit, and gives that version up" {
        New-TestNode "limitjob"
        New-StallingHashJob (Get-TestHashKey)
        $script:handoffHashJobSeconds = 0
        try {
            Write-Contract @()
            Invoke-TestHandoff
            "$($script:handoffHashJobs.Count) $($script:handoffHashGaveUp.ContainsKey((Get-TestHashKey)))" | Should Be "0 True"
        } finally { $script:handoffHashJobSeconds = 21600; $script:handoffHashGaveUp = @{}; Stop-HandoffHashJobs }
    }

    It "starts a new background hash when the version changed under the old one" {
        New-TestNode "backgroundchange"
        $script:handoffRunSeconds = 0
        try {
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            $script:handoffHashJobs.Count | Should Be 1
            $entry = New-Entry "clip.mp4"
            $entry.version = @("STICK:2")
            Write-Contract @($entry)
            Set-IndexEntry "clip.mp4" 5 "STICK:2"
            Wait-HashJobs
            Invoke-TestHandoff
            Get-Outcome "clip.mp4" | Should Be "deferred"
            @($script:handoffHashJobs.Keys)[0] | Should Match "STICK:2"
        } finally { $script:handoffRunSeconds = 20; Stop-HandoffHashJobs }
    }

    It "completes a move a run left between the rename and the manifest line, and never releases it" {
        New-TestNode "crashed"
        $global:fakeNeverIgnores = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        $global:fakeNeverIgnores = $false
        $relative = "$(Get-TrashDay)/videos/clip.mp4"
        $trashed = Join-Path (Get-TrashRoot) ($relative -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path $trashed) | Out-Null
        [System.IO.File]::Move((Join-Path $global:folder "clip.mp4"), $trashed)
        Set-PendingMoving ([pscustomobject]@{ pendingFile = (Join-Path $global:root ".storage\handoff-pending.jsonl") }) "videos" "clip.mp4" $relative
        Write-Contract @()
        Invoke-TestHandoff
        "$(Get-Outcome 'clip.mp4') $(Get-ListedCount 'clip.mp4') [$(Get-PendingPaths)] $(@(Read-HandoffLines (Join-Path (Get-TrashRoot) 'manifest.jsonl')).Count)" | Should Be "moved 1 [] 1"

        New-TestNode "crashedunclear"
        $global:fakeNeverIgnores = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        $global:fakeNeverIgnores = $false
        $trashed = Join-Path (Get-TrashRoot) "$(Get-TrashDay)\videos\clip.mp4"
        New-Item -ItemType Directory -Force -Path (Split-Path $trashed) | Out-Null
        Copy-Item -LiteralPath (Join-Path $global:folder "clip.mp4") -Destination $trashed
        [System.IO.File]::AppendAllText((Join-Path $global:folder "clip.mp4"), "changed")
        Set-PendingMoving ([pscustomobject]@{ pendingFile = (Join-Path $global:root ".storage\handoff-pending.jsonl") }) "videos" "clip.mp4" "$(Get-TrashDay)/videos/clip.mp4"
        Write-Contract @()
        Invoke-TestHandoff
        "$(Get-Outcome 'clip.mp4') $(Get-ListedCount 'clip.mp4') $(Get-PendingPaths)" | Should Be "ignored-not-moved 1 clip.mp4"
        Test-WasMoved ([pscustomobject]@{ pendingFile = (Join-Path $global:root ".storage\handoff-pending.jsonl"); manifest = (Join-Path (Get-TrashRoot) "manifest.jsonl") }) "videos" "clip.mp4" | Should Be $true
    }

    It "sets a torn pending line aside and appends after a last line without its newline" {
        New-TestNode "torn"
        Add-TestFile "second.mp4" "hello"
        $global:fakeNeverIgnores = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        $global:fakeNeverIgnores = $false
        $pendingFile = Join-Path $global:root ".storage\handoff-pending.jsonl"
        [System.IO.File]::AppendAllText($pendingFile, '{"folderId": "videos", "pa')
        Write-Contract @(New-Entry "second.mp4")
        Invoke-TestHandoff
        "$(Get-Outcome 'clip.mp4') $(Get-Outcome 'second.mp4') $(@([System.IO.File]::ReadAllLines("$pendingFile.bad")).Count)" | Should Be "moved moved 1"
        [System.IO.File]::WriteAllText((Join-Path $global:folder ".stignore-handoff"), "/clip.mp4")
        Add-TestFile "third.mp4" "hello"
        Write-Contract @(New-Entry "third.mp4")
        Invoke-TestHandoff
        ([System.IO.File]::ReadAllLines((Join-Path $global:folder ".stignore-handoff")) -join " ") | Should Be "/clip.mp4 /third.mp4"
    }

    It "counts attempts for a pending path whose folder is refused, and releases it when they run out" {
        New-TestNode "refusedfolder"
        $global:fakeNeverIgnores = $true
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        $global:fakeFolders.videos.type = "sendreceive"
        $script:handoffPendingAttempts = 2
        Write-Contract @()
        Invoke-TestHandoff
        Get-Outcome "clip.mp4" | Should Be "ignored-not-moved"
        Invoke-TestHandoff
        "$(Get-Outcome 'clip.mp4') $(Get-ListedCount 'clip.mp4')" | Should Be "released 0"
    }

    It "looks at a bounded number of handed-off paths per run" {
        New-TestNode "strays"
        [System.IO.File]::WriteAllText((Join-Path $global:folder ".stignore-handoff"), "/a.mp4`n/b.mp4`n")
        Add-TestFile "a.mp4" "hello"
        Add-TestFile "b.mp4" "hello"
        $script:handoffStrayLimit = 1
        try {
            Write-Contract @(New-Entry "clip.mp4")
            Invoke-TestHandoff
            $first = (@((Get-Result).results | Where-Object { $_.outcome -eq "unsynced-at-handed-off-path" }) | ForEach-Object { $_.path }) -join " "
            Write-Contract @()
            Invoke-TestHandoff
            $second = (@((Get-Result).results | Where-Object { $_.outcome -eq "unsynced-at-handed-off-path" }) | ForEach-Object { $_.path }) -join " "
            "$first|$second" | Should Be "a.mp4|b.mp4"
        } finally { $script:handoffStrayLimit = 1000 }
    }

    It "acts only inside the node's own root, and never through a link" {
        New-TestNode "paths"
        $outside = Join-Path $scratch "outside"
        New-Item -ItemType Directory -Force -Path $outside | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $outside "secret.mp4"), "hello")
        Set-OldTime (Join-Path $outside "secret.mp4") ($global:handoffTestNow - 3600)
        cmd /c mklink /J (Join-Path $global:folder "linked") $outside | Out-Null
        Set-IndexEntry "linked/secret.mp4" 5
        Write-Contract @((New-Entry "linked/secret.mp4"), (New-Entry "../../outside/secret.mp4"), (New-Entry "star*.mp4"), (New-Entry "back\slash.mp4"), (New-Entry "C:/Windows/win.ini"), (New-Entry "trail.mp4 "), (New-Entry " lead/x.mp4"))

        Invoke-TestHandoff

        foreach ($name in @("linked/secret.mp4", "../../outside/secret.mp4", "star*.mp4", "back\slash.mp4", "C:/Windows/win.ini", "trail.mp4 ", " lead/x.mp4")) { Get-Outcome $name | Should Be "refused" }
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

    It "empties only the trash under a held contract, moving nothing, and says what the trash still holds" {
        New-TestNode "held"
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        (Get-Result).trashBytes | Should Be 5
        Add-TestFile "pending.mp4" "hello"
        $global:fakeNeverIgnores = $true
        Write-Contract @(New-Entry "pending.mp4")
        Invoke-TestHandoff
        $global:fakeNeverIgnores = $false
        Get-PendingPaths | Should Be "pending.mp4"
        $moved = $global:handoffTestNow

        $global:handoffTestNow = $moved + 8 * 86400
        $held = [pscustomobject]@{
            schema = 1; nodeId = "a001"; writtenAt = [DateTimeOffset]::FromUnixTimeSeconds($global:handoffTestNow - 10).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            apply = $false; trashOnly = $true; cluster = $false; quietMinutes = 10; entries = @(); waiting = @(); notes = @("hand-offs are held: x")
        }
        [System.IO.File]::WriteAllText($global:contractPath, (ConvertTo-Json -InputObject $held -Depth 10))
        Invoke-TestHandoff
        $result = Get-Result
        "$($null -eq $result.refused) $($result.purged) $($result.trashBytes) $(@($result.results).Count) $(Test-Present 'pending.mp4') $(Get-PendingPaths)" | Should Be "True 1 0 0 True pending.mp4"
        $result.notes[0] | Should Be "the contract holds every hand-off: only the trash is emptied"

        $held.entries = @(New-Entry "pending.mp4")
        [System.IO.File]::WriteAllText($global:contractPath, (ConvertTo-Json -InputObject $held -Depth 10))
        Invoke-TestHandoff
        (Get-Result).refused | Should Be "the contract is not in apply mode"
    }

    It "empties the trash under a trash-only contract without the node file's apply, and counts only copies kept for their age alone" {
        New-TestNode "heldoff"
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        Add-TestFile "second.mp4" "hello"
        Write-Contract @(New-Entry "second.mp4")
        Invoke-TestHandoff
        (Get-Result).trashBytes | Should Be 10
        [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\node.toml"), "[node]`nid = `"a001`"`nname = `"stick`"`nkind = `"folder`"`n")
        Set-IndexEntry "second.mp4" 5 "STICK:1" @([pscustomobject]@{ id = "OTHER-DEVICE"; fromTemporary = $false })
        $global:handoffTestNow += 8 * 86400
        $held = [pscustomobject]@{
            schema = 1; nodeId = "a001"; writtenAt = [DateTimeOffset]::FromUnixTimeSeconds($global:handoffTestNow - 10).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            apply = $false; trashOnly = $true; cluster = $false; quietMinutes = 10; entries = @(); waiting = @(); notes = @()
        }
        [System.IO.File]::WriteAllText($global:contractPath, (ConvertTo-Json -InputObject $held -Depth 10))
        Invoke-TestHandoff
        $result = Get-Result
        "$($null -eq $result.refused) $($result.purged) $($result.trashBytes)" | Should Be "True 1 0"

        Write-Contract @()
        Invoke-TestHandoff
        (Get-Result).refused | Should Be "the node file does not say apply = true"
    }

    It "keeps a trash copy until its recorded keeper is connected and holds that version or a later one" {
        New-TestNode "keeperless"
        Write-Contract @(New-Entry "clip.mp4")
        Invoke-TestHandoff
        $day = Get-TrashDay
        $trashed = Join-Path (Get-TrashRoot) "$day\videos\clip.mp4"
        Set-IndexEntry "clip.mp4" 5 "STICK:1" @([pscustomobject]@{ id = "OTHER-DEVICE"; fromTemporary = $false })
        $global:handoffTestNow += 8 * 86400
        Write-Contract @()
        Invoke-TestHandoff
        "$(Test-Path -LiteralPath $trashed) $((Get-Result).purged) $(Get-TrashKept)" | Should Be "True 0 $day/videos/clip.mp4: its keeper does not hold it, as this node sees it"
        $manifest = Join-Path (Get-TrashRoot) "manifest.jsonl"
        $keptAt = (@(Read-HandoffLines $manifest)[0]).keptAt
        $global:handoffTestNow += 60
        Write-Contract @()
        Invoke-TestHandoff
        "$(@((Get-Result).trash).Count) $((@(Read-HandoffLines $manifest)[0]).keptAt)" | Should Be "1 $keptAt"
        Set-IndexEntry "clip.mp4" 5
        $global:fakeConnections = [pscustomobject]@{ connections = [pscustomobject]@{ $keeperDevice = [pscustomobject]@{ connected = $false } } }
        Invoke-TestHandoff
        Get-TrashKept | Should Be "$day/videos/clip.mp4: its keeper is not connected to this node"
        $global:fakeConnections = [pscustomobject]@{ connections = [pscustomobject]@{ $keeperDevice = [pscustomobject]@{ connected = $true } } }
        Set-IndexEntry "clip.mp4" 5 "OTHER:7"
        Invoke-TestHandoff
        Get-TrashKept | Should Be "$day/videos/clip.mp4: the network no longer has its version or a later one"
        Set-IndexEntry "clip.mp4" 5
        $global:fakeFiles["videos|clip.mp4"].global | Add-Member -NotePropertyName deleted -NotePropertyValue $true -Force
        Invoke-TestHandoff
        Get-TrashKept | Should Be "$day/videos/clip.mp4: the network has its deletion"
        Set-IndexEntry "clip.mp4" 9
        $global:fakeFiles["videos|clip.mp4"].global.version = @("STICK:1", "KEEPER:1")
        Invoke-TestHandoff
        "$(Test-Path -LiteralPath $trashed) $((Get-Result).purged)" | Should Be "False 1"
    }

    It "never follows a manifest line outside the trash or through a link" {
        New-TestNode "manifest"
        $beyond = Join-Path $scratch "beyond"
        New-Item -ItemType Directory -Force -Path $beyond, (Get-TrashRoot) | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $beyond "secret.mp4"), "hello")
        Set-OldTime (Join-Path $beyond "secret.mp4") ($global:handoffTestNow - 3600)
        cmd /c mklink /J (Join-Path (Get-TrashRoot) "linked") $beyond | Out-Null
        $manifest = Join-Path (Get-TrashRoot) "manifest.jsonl"
        foreach ($trash in @("../../Videos/clip.mp4", "linked/secret.mp4")) {
            Add-HandoffLine $manifest ([ordered]@{ movedAt = 0; trash = $trash; folderId = "videos"; path = "clip.mp4"; version = @("STICK:1"); size = 5; modifiedSeconds = ($global:handoffTestNow - 3600) })
        }
        Write-Contract @()
        Invoke-TestHandoff
        "$(Test-Present 'clip.mp4') $(Test-Path -LiteralPath (Join-Path $beyond 'secret.mp4')) $((Get-Result).purged) $(@((Get-Result).trash).Count)" | Should Be "True True 0 2"
        cmd /c rmdir (Join-Path (Get-TrashRoot) "linked") | Out-Null
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
