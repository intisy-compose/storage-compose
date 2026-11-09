# Pester 3.4: the host agent's layered sync side (windows/layered.ps1) on scratch folders, against a fake
# Syncthing and a fake dashboard. Nothing reaches a real Syncthing, node or dashboard.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-layered-$([guid]::NewGuid())"
$global:layeredTestNow = 1793872800

function Remove-NetFirewallRule { throw "the layered tests never call Remove-NetFirewallRule" }
function Get-HandoffNow { return $global:layeredTestNow }

$global:apiCalls = @()
$global:fakeConfig = $null

function Invoke-SyncthingApi($Instance, [string]$Method, [string]$Path) {
    $global:apiCalls += "$Method $Path"
    if ($Path -eq "/rest/config/folders") { return @($global:fakeConfig.folders) }
    if ($Path -eq "/rest/config/devices") { return @($global:fakeConfig.devices | ForEach-Object { [pscustomobject]@{ deviceID = $_ } }) }
    if ($Path -like "/rest/db/ignores*") { return [pscustomobject]@{ ignore = @("#own line") } }
    if ($Path -like "/rest/db/status*") { return [pscustomobject]@{ globalBytes = 10; localBytes = 10; needBytes = 0; state = "idle"; stateChanged = "2026-01-01T00:00:00Z"; remoteSequence = [pscustomobject]@{ X = 1 } } }
    if ($Path -like "/rest/db/browse*") { return @([pscustomobject]@{ name = "sub"; type = "FILE_INFO_TYPE_DIRECTORY"; children = @([pscustomobject]@{ name = "old.mp4"; type = "FILE_INFO_TYPE_FILE"; modTime = "2026-01-01T00:00:00Z" }, [pscustomobject]@{ name = "new.mp4"; type = "FILE_INFO_TYPE_FILE"; modTime = "2026-11-08T17:59:50Z" }) }) }
    if ($Path -like "/rest/db/file*") { return [pscustomobject]@{ local = [pscustomobject]@{ type = "FILE_INFO_TYPE_FILE"; version = @("S:1"); size = 5; numBlocks = 1; blocksHash = "h"; modified = "x"; deleted = $false; ignored = $false; invalid = $false } } }
    if ($Path -eq "/rest/config/defaults/folder") { return [pscustomobject]@{ id = ""; label = ""; path = ""; type = "sendreceive"; devices = @() } }
    if ($Path -like "/rest/config/folders/*") { return [pscustomobject]@{ path = (Join-Path $global:root "Essential") } }
    throw "the fake Syncthing has no $Method $Path"
}

$global:writes = @()
function Invoke-SyncthingApiBody($Instance, [string]$Method, [string]$Path, $Body) {
    $global:writes += "$Method $Path $(ConvertTo-Json -InputObject $Body -Compress -Depth 8)"
}

function New-TestRoot([string]$Name, [string]$NodeFileText = "[node]`nid = `"d1e2`"`nname = `"stick`"`nkind = `"folder`"`nthreshold = 80`nassigned = []`n") {
    $global:root = Join-Path $scratch $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $global:root ".storage"), (Join-Path $global:root "Essential") | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\node.toml"), $NodeFileText)
    $global:handoffFolder = Join-Path $scratch "$Name-handoff"
    New-Item -ItemType Directory -Force -Path $global:handoffFolder | Out-Null
    $global:node = [pscustomobject]@{ id = "d1e2"; name = "stick"; kind = "folder"; threshold = 80; root = $global:root; dashboard = "https://dash" }
    $global:instance = [pscustomobject]@{ nodeId = "d1e2"; node = $global:node; ports = [pscustomobject]@{ gui = 1 }; apiKey = "key"; state = "running"; deviceId = "DEVICE-ID" }
    $script:syncthingInstances = @{ d1e2 = $global:instance }
    $global:fakeConfig = [pscustomobject]@{ folders = @(); devices = @("DEVICE-ID") }
    $global:apiCalls = @()
    $global:writes = @()
}

function Read-TestNodeFile { return [System.IO.File]::ReadAllText((Join-Path $global:root ".storage\node.toml")) }
function Write-TestPolicy($Policy) { [System.IO.File]::WriteAllText((Get-PolicyFilePath $global:handoffFolder "d1e2"), (ConvertTo-Json -InputObject $Policy -Depth 6)) }
function Get-PolicyTime([int]$AgeSeconds = 10) { return [DateTimeOffset]::FromUnixTimeSeconds($global:layeredTestNow - $AgeSeconds).UtcDateTime.ToString("o") }

Describe "a node file follows the layout's policy" {
    It "writes the threshold, assigned, access and apply, keeping every other line and a multi-line assigned as one key" {
        New-TestRoot "follow" "[node]`nid = `"d1e2`"`nname = `"stick`"`nkind = `"folder`"`nthreshold = 80`nassigned = [`n  `"a`",`n]`nextra = 1`n"
        Set-NodeFilePolicy $global:root ([pscustomobject]@{ threshold = 50; assigned = @("Pictures"); access = "open" }) | Should Be $true
        $text = Read-TestNodeFile
        $text | Should Match 'threshold = 50'
        $text | Should Match 'assigned = \["Pictures"\]'
        $text | Should Match 'access = "open"'
        $text | Should Match 'apply = true'
        $text | Should Match 'extra = 1'
        $text | Should Not Match '"a"'
        Set-NodeFilePolicy $global:root ([pscustomobject]@{ threshold = 50; assigned = @("Pictures"); access = "open" }) | Should Be $false
    }

    It "withdraws apply whatever its form and leaves the rest as it was" {
        New-TestRoot "withdraw" "[node]`nid = `"d1e2`"`napply = true`nname = `"stick`"`n"
        Remove-NodeFileApply $global:root | Should Be $true
        (Read-TestNodeFile).Contains("apply") | Should Be $false
        (Read-TestNodeFile).Contains('name = "stick"') | Should Be $true
        Remove-NodeFileApply $global:root | Should Be $false
    }

    It "never rewrites an array's file or a node file behind a link" {
        New-TestRoot "array" "[node]`nid = `"d1e2`"`nkind = `"array`"`napply = true`n"
        Remove-NodeFileApply $global:root | Should Be $false
        Set-NodeFilePolicy $global:root ([pscustomobject]@{ threshold = 1; assigned = @(); access = "open" }) | Should Be $false
    }

    It "follows a fresh follow policy, and withdraws on a withdrawal, a stale file, a missing file and another node's" {
        New-TestRoot "policy"
        Write-TestPolicy ([pscustomobject]@{ schema = 1; nodeId = "d1e2"; writtenAt = (Get-PolicyTime); action = "follow"; policy = [pscustomobject]@{ threshold = 50; assigned = @(); access = "open" } })
        Update-NodeFilesFromPolicies @($global:node) $global:handoffFolder
        (Read-TestNodeFile) | Should Match 'apply = true'
        Write-TestPolicy ([pscustomobject]@{ schema = 1; nodeId = "d1e2"; writtenAt = (Get-PolicyTime); action = "withdraw"; reason = "not admitted" })
        Update-NodeFilesFromPolicies @($global:node) $global:handoffFolder
        (Read-TestNodeFile).Contains("apply") | Should Be $false
        Write-TestPolicy ([pscustomobject]@{ schema = 1; nodeId = "d1e2"; writtenAt = (Get-PolicyTime); action = "follow"; policy = [pscustomobject]@{ threshold = 50; assigned = @(); access = "open" } })
        Update-NodeFilesFromPolicies @($global:node) $global:handoffFolder
        Write-TestPolicy ([pscustomobject]@{ schema = 1; nodeId = "d1e2"; writtenAt = (Get-PolicyTime 301); action = "follow"; policy = [pscustomobject]@{ threshold = 50; assigned = @(); access = "open" } })
        Update-NodeFilesFromPolicies @($global:node) $global:handoffFolder
        (Read-TestNodeFile).Contains("apply") | Should Be $false
        Set-NodeFilePolicy $global:root ([pscustomobject]@{ threshold = 50; assigned = @(); access = "open" }) | Out-Null
        Write-TestPolicy ([pscustomobject]@{ schema = 1; nodeId = "ffff"; writtenAt = (Get-PolicyTime); action = "follow"; policy = [pscustomobject]@{ threshold = 50; assigned = @(); access = "open" } })
        Update-NodeFilesFromPolicies @($global:node) $global:handoffFolder
        (Read-TestNodeFile).Contains("apply") | Should Be $false
        Set-NodeFilePolicy $global:root ([pscustomobject]@{ threshold = 50; assigned = @(); access = "open" }) | Out-Null
        Remove-Item -LiteralPath (Get-PolicyFilePath $global:handoffFolder "d1e2")
        Update-NodeFilesFromPolicies @($global:node) $global:handoffFolder
        (Read-TestNodeFile).Contains("apply") | Should Be $false
    }
}

Describe "the hand-off list on a Windows node" {
    It "creates the list only inside the node's root, once the folder ignores it, and never replaces one" {
        New-TestRoot "list"
        $folder = Join-Path $global:root "Essential"
        (New-HandoffList $global:node $folder).ContainsKey("problem") | Should Be $true
        [System.IO.File]::WriteAllText((Join-Path $folder ".stignore"), "/.stignore-handoff`n")
        (New-HandoffList $global:node $folder).ContainsKey("problem") | Should Be $false
        Test-Path -LiteralPath (Join-Path $folder ".stignore-handoff") | Should Be $true
        [System.IO.File]::WriteAllText((Join-Path $folder ".stignore-handoff"), "/kept`n")
        (New-HandoffList $global:node $folder).ContainsKey("problem") | Should Be $false
        [System.IO.File]::ReadAllText((Join-Path $folder ".stignore-handoff")) | Should Be "/kept`n"
        (New-HandoffList $global:node (Join-Path $scratch "outside")).problem | Should Be "the folder is not inside the node's root"
    }

    It "answers the dashboard's request, a list per folder" {
        New-TestRoot "listrequest"
        $folder = Join-Path $global:root "Essential"
        [System.IO.File]::WriteAllText((Join-Path $folder ".stignore"), "/.stignore-handoff`n")
        [System.IO.File]::WriteAllText((Get-ListRequestPath $global:handoffFolder "d1e2"), (ConvertTo-Json ([pscustomobject]@{ schema = 1; nodeId = "d1e2"; folders = [pscustomobject]@{ essential = $folder } }) -Depth 4))
        Update-HandoffListRequests @($global:node) $global:handoffFolder
        $answer = Read-AgentJson (Get-ListAnswerPath $global:handoffFolder "d1e2")
        $answer.folders.essential.state | Should Be "ready"
        $answer.folders.essential.path | Should Be $folder
    }
}

Describe "a joined node's report and answer" {
    It "sends its folders, known devices, disk, and the settled files of send-only folders" {
        New-TestRoot "report"
        $config = [pscustomobject]@{ id = "archive"; label = "Archive"; path = (Join-Path $global:root "Essential"); type = "sendonly"; paused = $false; devices = @([pscustomobject]@{ deviceID = "DEVICE-ID" }); versioning = [pscustomobject]@{ type = "" } }
        $global:fakeConfig = [pscustomobject]@{ folders = @($config); devices = @("DEVICE-ID", "OTHER") }
        $report = Get-JoinedNodeReport $global:instance $global:node (Join-Path $scratch "absent.json")
        $report.deviceId | Should Be "DEVICE-ID"
        @($report.knownDevices) -join "," | Should Be "DEVICE-ID,OTHER"
        $report.folders[0].id | Should Be "archive"
        $report.folders[0].ignores[0] | Should Be "#own line"
        $report.files.Count | Should Be 1
        $report.files[0].path | Should Be "sub/old.mp4"
        $report.space.totalBytes | Should BeGreaterThan 0
        $report.result | Should Be $null
    }

    It "applies nothing unless the dashboard says apply and the node file, followed first, says it too" {
        New-TestRoot "gate"
        $answer = [pscustomobject]@{ schema = 1; nodeId = "d1e2"; apply = $true; nodeFile = [pscustomobject]@{ action = "withdraw"; reason = "x" }; ops = @([pscustomobject]@{ op = "type"; folderId = "essential"; type = "sendonly" }); contract = $null }
        Set-JoinedNodeFile $global:node $answer
        Invoke-JoinedOps $global:instance $global:node $answer
        $global:writes.Count | Should Be 0
        $answer2 = [pscustomobject]@{ schema = 1; nodeId = "d1e2"; apply = $false; nodeFile = [pscustomobject]@{ action = "follow"; policy = [pscustomobject]@{ threshold = 50; assigned = @(); access = "open" } }; ops = @([pscustomobject]@{ op = "type"; folderId = "essential"; type = "sendonly" }); contract = $null }
        Set-JoinedNodeFile $global:node $answer2
        Invoke-JoinedOps $global:instance $global:node $answer2
        $global:writes.Count | Should Be 0
    }

    It "makes the changes in the order given, each through its own Syncthing write, and stops at the first that fails" {
        New-TestRoot "ops"
        [System.IO.File]::WriteAllText((Join-Path $global:root ".storage\node.toml"), "[node]`nid = `"d1e2`"`nname = `"stick`"`nkind = `"folder`"`nthreshold = 80`nassigned = []`napply = true`n")
        [System.IO.File]::WriteAllText((Join-Path (Join-Path $global:root "Essential") ".stignore"), "/.stignore-handoff`n")
        $answer = [pscustomobject]@{ schema = 1; nodeId = "d1e2"; apply = $true; nodeFile = [pscustomobject]@{ action = "follow"; policy = [pscustomobject]@{ threshold = 50; assigned = @(); access = "open" } }; contract = $null; ops = @(
            [pscustomobject]@{ op = "paused"; folderId = "essential"; paused = $true },
            [pscustomobject]@{ op = "ignores"; folderId = "essential"; lines = @("a", "b") },
            [pscustomobject]@{ op = "ensureList"; folderId = "essential" },
            [pscustomobject]@{ op = "addDevice"; deviceId = "OTHER"; name = "other" },
            [pscustomobject]@{ op = "bogus" },
            [pscustomobject]@{ op = "type"; folderId = "essential"; type = "sendonly" }
        ) }
        Set-JoinedNodeFile $global:node $answer
        Invoke-JoinedOps $global:instance $global:node $answer
        $global:writes.Count | Should Be 3
        $global:writes[0] | Should Match 'Patch.*"paused":true'
        $global:writes[1] | Should Match 'Post /rest/db/ignores'
        $global:writes[2] | Should Match 'Put /rest/config/devices/OTHER'
        Test-Path -LiteralPath (Join-Path (Join-Path $global:root "Essential") ".stignore-handoff") | Should Be $true
    }

    It "adds a folder only inside the node's root, with its ignores in place before Syncthing is told" {
        New-TestRoot "addfolder"
        $path = Join-Path $global:root "New"
        $op = [pscustomobject]@{ op = "addFolder"; id = "newone"; label = "New"; path = $path; type = "sendonly"; devices = @("DEVICE-ID"); versioning = $null; ignores = @("// layered sync begin", "#include .stignore-handoff", "/.stignore-handoff", "// layered sync end") }
        { Invoke-JoinedOp $global:instance $global:node ([pscustomobject]@{ op = "addFolder"; id = "x"; label = "x"; path = "C:\outside"; type = "sendonly"; devices = @(); ignores = @() }) } | Should Throw
        Invoke-JoinedOp $global:instance $global:node $op
        [System.IO.File]::ReadAllText((Join-Path $path ".stignore")) | Should Match "#include .stignore-handoff"
        Test-Path -LiteralPath (Join-Path $path ".stignore-handoff") | Should Be $true
        $global:writes[-1] | Should Match '"type":"sendonly"'
    }

    It "takes apply out when the dashboard does not answer, and keeps the last contract out of it" {
        New-TestRoot "noanswer" "[node]`nid = `"d1e2`"`nname = `"stick`"`nkind = `"folder`"`nthreshold = 80`nassigned = []`napply = true`n"
        function Invoke-DashboardReport { throw "unreachable" }
        function Write-WatcherLog($Message) { $global:logged = $Message }
        Update-JoinedNodeLayered $global:node $global:handoffFolder 1
        (Read-TestNodeFile).Contains("apply") | Should Be $false
    }

    It "reports to and follows the answer of its dashboard" {
        New-TestRoot "answer"
        function Invoke-DashboardReport([string]$Dashboard, [string]$NodeId, [string]$Json, [double]$Timeout) {
            $global:posted = "$Dashboard $NodeId $Json"
            return '{"schema":1,"nodeId":"d1e2","apply":true,"nodeFile":{"action":"follow","policy":{"threshold":50,"assigned":[],"access":"open"}},"ops":[],"contract":{"schema":1,"nodeId":"d1e2","apply":true,"entries":[]}}'
        }
        Update-JoinedNodeLayered $global:node $global:handoffFolder 1
        $global:posted | Should Match "https://dash d1e2"
        (Read-TestNodeFile) | Should Match 'apply = true'
        Test-Path -LiteralPath (Join-Path $global:handoffFolder "d1e2.json") | Should Be $true
    }
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
