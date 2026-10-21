# Pester 3.4: the Windows join script against the fake dashboard (tests/join/fake-dashboard.py), which
# admits the device into a real Syncthing peer, with the device's own real Syncthing. Tailscale and the
# scheduled task are faked (the task starts the process directly); the node is a subst drive over a
# temporary folder, so neither F:\ nor the tailnet is touched. Needs python on the PATH.

param([string]$Python = "python")

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "join\storage-join.ps1")
. (Join-Path $PSScriptRoot "..\agent\test-volumes.ps1")
. (Join-Path $PSScriptRoot "..\agent\firewall-guard.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "join-windows-$([guid]::NewGuid())"
$realLocalAppData = $env:LOCALAPPDATA
$userSyncthingGuiPort = 18490
$userSyncthingListenPort = 32190
$peerGuiPort = 18491
$dashboardPort = 18099
$tailscaleCli = Join-Path $scratch "fake\tailscale.exe"
$global:tailnetState = "NeedsLogin"
$global:tailscaleUps = @()
$global:tasks = @{}
$global:registrations = 0
$global:taskCalls = @()
$realNativeCommand = ${function:Invoke-NativeCommand}

function Invoke-NativeCommand([string]$FilePath, [string[]]$Arguments, [string]$InputText) {
    if ($FilePath -ne $tailscaleCli) { return & $realNativeCommand $FilePath $Arguments $InputText }
    switch ($Arguments[0]) {
        "status" { return [pscustomobject]@{ Output = "{`"BackendState`": `"$global:tailnetState`", `"MagicDNSSuffix`": `"tail-test.ts.net`"}"; ExitCode = 0 } }
        "ip" { return [pscustomobject]@{ Output = "100.64.0.9"; ExitCode = 0 } }
        "up" { $global:tailscaleUps += ($Arguments -join " "); $global:tailnetState = "Running"; return [pscustomobject]@{ Output = ""; ExitCode = 0 } }
    }
}
function Get-TailnetAddress { return "127.0.0.1" }
function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName);  if ($TaskName) { return $global:tasks[$TaskName] }; return @($global:tasks.Values) }
function Disable-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath); $global:taskCalls += "disable $TaskName" }
function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath, [switch]$Confirm); $global:taskCalls += "unregister $TaskName"; $global:tasks.Remove($TaskName) }
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument);  return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn, [string]$User);  return "at logon of $User" }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param($ExecutionTimeLimit, $RestartCount, $RestartInterval, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries);  return "settings" }
function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName, $Action, $Trigger, $Settings, [switch]$Force); 
    $global:tasks[$TaskName] = [pscustomobject]@{ TaskName = $TaskName; TaskPath = "\"; Actions = @($Action) }
    $global:registrations++
}
function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName); 
    $action = $global:tasks[$TaskName].Actions[0]
    Start-Process -FilePath $action.Execute -ArgumentList $action.Arguments -WindowStyle Hidden
}

$global:answers = New-Object System.Collections.Queue
$global:questions = @()
$global:logLines = @()
$global:terminal = $false
function Write-JoinLog([string]$Message) { $global:logLines += $Message }
function Test-InputIsTerminal { return $global:terminal }
function Read-JoinAnswer([string]$Question, [string]$Default) {
    $global:questions += $(if ($Default) { "$Question [$Default]" } else { $Question })
    if ($global:answers.Count -eq 0) { throw "no answer to: $Question" }
    $answer = $global:answers.Dequeue()
    if ($answer -eq "") { return $Default }
    return $answer
}

function Invoke-Choices([string[]]$Answers) {
    $global:answers = New-Object System.Collections.Queue
    foreach ($answer in $Answers) { $global:answers.Enqueue($answer) }
    $global:questions = @()
    $global:logLines = @()
    $script:keepAllConfirmed = $false
    try { return "$(Read-JoinChoices)" } catch { return "failed: $_" }
}

function Get-ApiKey([string]$SyncthingHome) { return ([xml][System.IO.File]::ReadAllText((Join-Path $SyncthingHome "config.xml"))).configuration.gui.apikey }

function Invoke-Peer([string]$Method, [string]$Path, $Body) {
    $arguments = @{ Method = $Method; Uri = "http://127.0.0.1:$peerGuiPort$Path"; Headers = @{ "X-API-Key" = (Get-ApiKey $script:peerHome) }; UseBasicParsing = $true }
    if ($Body) { $arguments["Body"] = $Body; $arguments["ContentType"] = "application/json" }
    return Invoke-RestMethod @arguments
}

function Invoke-Device([string]$Path) {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$userSyncthingGuiPort$Path" -Headers @{ "X-API-Key" = (Get-ApiKey "$script:nodeRoot.storage\syncthing") } -UseBasicParsing
}

function Start-Peer {
    $script:peerHome = Join-Path $scratch "peer"
    & $script:syncthingPath generate "--home=$script:peerHome" --no-port-probing 2>&1 | Out-Null
    $script:peer = Start-Process -FilePath $script:syncthingPath -ArgumentList "serve --home=`"$script:peerHome`" --no-browser --no-upgrade --gui-address=127.0.0.1:$peerGuiPort" -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) { try { Invoke-Peer "Get" "/rest/system/status" | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
    Invoke-Peer "Patch" "/rest/config/options" '{"listenAddresses": ["tcp://127.0.0.1:32191"], "globalAnnounceEnabled": false, "localAnnounceEnabled": false, "relaysEnabled": false, "natEnabled": false, "urAccepted": -1}' | Out-Null
}

function Start-Dashboard {
    $arguments = @((Join-Path $PSScriptRoot "fake-dashboard.py"), $dashboardPort, "http://127.0.0.1:$peerGuiPort", (Get-ApiKey $script:peerHome),
        "tcp://127.0.0.1:32191", (Join-Path $scratch "dashboard"), "tcp://127.0.0.1:$userSyncthingListenPort", ((Join-Path $scratch "peer-folders") -replace '\\', '/'))
    $script:dashboardProcess = Start-Process -FilePath $Python -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
}

function Stop-Everything {
    if ($script:substLetter) { & subst.exe "$($script:substLetter):" /D | Out-Null }
    foreach ($process in @(Get-SyncthingProcesses)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($script:dashboardProcess) { Stop-Process -Id $script:dashboardProcess.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Get-CimInstance Win32_Process -Filter "Name='syncthing.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($scratch) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($script:adoptLetter) { & subst.exe "$($script:adoptLetter):" /D | Out-Null }
    if ($script:folderLetter) { & subst.exe "$($script:folderLetter):" /D | Out-Null }
    Remove-ProgramFirewallRules (Join-Path $repository "host-agent\bin")
    Remove-ProgramFirewallRules $scratch
    $env:LOCALAPPDATA = $realLocalAppData
    for ($attempt = 0; $attempt -lt 10 -and (Test-Path $scratch); $attempt++) {
        Start-Sleep -Seconds 1
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
    }
}

function Invoke-JoinCapturingFailure {
    try { Invoke-Join 6>$null; return "ok" } catch { return "$_" }
}

function Get-RequestLines { return @(Get-Content (Join-Path $scratch "dashboard\requests.jsonl")) }

New-Item -ItemType Directory -Force -Path (Split-Path $tailscaleCli), (Join-Path $scratch "volume") | Out-Null
Set-Content -Path $tailscaleCli -Value "fake"
$script:syncthingPath = Get-SyncthingBinary $repository
Add-TestFirewallGuard $script:syncthingPath
$script:substLetter = Get-FreeDriveLetter
& subst.exe "$($script:substLetter):" (Join-Path $scratch "volume") | Out-Null
$script:nodeRoot = "$($script:substLetter):\"
$Root = $script:nodeRoot
$Name = "pc-test"
$Dashboard = "http://127.0.0.1:$dashboardPort"
$AuthKey = "tskey-test"

try {
    Start-Peer
    Start-Dashboard
    $env:LOCALAPPDATA = Join-Path $scratch "localappdata"

    Describe "the first run" {
        $outcome = Invoke-JoinCapturingFailure

        It "succeeds" { $outcome | Should Be "ok" }
        It "joins the tailnet with the key and the device name" { $global:tailscaleUps | Should Be @("up --auth-key=tskey-test --hostname=pc-test --unattended") }
        It "writes a drive node file at the volume root" {
            $node = Read-NodeFile $script:nodeRoot
            $node.kind | Should Be "drive"
            $node.name | Should Be "pc-test"
            $node.threshold | Should Be 50
            $node.id | Should Match '^[0-9a-f]{4}$'
        }
        It "runs Syncthing at logon from a task, with its home on the node" {
            $task = $global:tasks["storage-compose syncthing pc-test"]
            $task.Actions[0].Execute | Should Be $script:syncthingPath
            $task.Actions[0].Arguments | Should Match ([regex]::Escape("--home=`"$($script:nodeRoot).storage\syncthing`""))
        }
        It "opens its sync port to the tailnet only, before Windows can ask" {
            $node = Read-NodeFile $script:nodeRoot
            $rule = Get-NetFirewallRule -Name "storage-compose syncthing $($node.id)" -ErrorAction SilentlyContinue
            ($rule | Get-NetFirewallPortFilter).LocalPort | Should Be "$userSyncthingListenPort"
            ($rule | Get-NetFirewallAddressFilter).RemoteAddress | Should Be "100.64.0.0/255.192.0.0"
            [bool](Get-NetFirewallRule -Name "storage-compose syncthing $($node.id) udp" -ErrorAction SilentlyContinue) | Should Be $true
        }
        It "listens on the tailnet only" {
            $options = Invoke-Device "/rest/config/options"
            @($options.listenAddresses) | Should Be @("tcp://127.0.0.1:$userSyncthingListenPort")
            $options.globalAnnounceEnabled | Should Be $false
            $options.relaysEnabled | Should Be $false
        }
        It "sends the contract's request" {
            $request = @(Get-RequestLines)[0] | ConvertFrom-Json
            $request.name | Should Be "pc-test"
            $request.os | Should Be "windows"
            $request.syncthingDeviceId | Should Be (Invoke-Device "/rest/system/status").myID
            $request.nodes[0].kind | Should Be "drive"
            $request.nodes[0].path | Should Be $script:nodeRoot
        }
        It "applies the answer: the peer and both folders, shared with it" {
            $peerId = (Invoke-Peer "Get" "/rest/system/status").myID
            (Invoke-Device "/rest/config/devices/$peerId").name | Should Be "storage"
            $folder = Invoke-Device "/rest/config/folders/documents-github"
            $folder.path | Should Be "$($script:nodeRoot)Documents\GitHub"
            @($folder.devices | ForEach-Object { $_.deviceID }) -contains $peerId | Should Be $true
        }
        It "is connected to by the peer" {
            $deviceId = (Invoke-Device "/rest/system/status").myID
            $connected = $false
            $deadline = (Get-Date).AddSeconds(60)
            while (-not $connected -and (Get-Date) -lt $deadline) {
                $connections = Invoke-Peer "Get" "/rest/system/connections"
                $connected = [bool]($connections.connections.PSObject.Properties[$deviceId] -and $connections.connections.$deviceId.connected)
                if (-not $connected) { Start-Sleep -Seconds 1 }
            }
            $connected | Should Be $true
        }
    }

    Describe "the second run" {
        $nodeBefore = Get-FileHash "$($script:nodeRoot).storage\node.toml"
        $configBefore = Get-FileHash "$($script:nodeRoot).storage\syncthing\config.xml"
        $registrationsBefore = $global:registrations
        $script:joinChanges = 0
        $outcome = Invoke-JoinCapturingFailure

        It "succeeds and changes nothing" {
            $outcome | Should Be "ok"
            $script:joinChanges | Should Be 0
            (Get-FileHash "$($script:nodeRoot).storage\node.toml").Hash | Should Be $nodeBefore.Hash
            (Get-FileHash "$($script:nodeRoot).storage\syncthing\config.xml").Hash | Should Be $configBefore.Hash
            $global:registrations | Should Be $registrationsBefore
            @($global:tailscaleUps).Count | Should Be 1
            @(Get-RequestLines).Count | Should Be 2
        }
    }

    Describe "refusals" {
        It "needs a key while not on the tailnet" {
            $global:tailnetState = "NeedsLogin"
            $AuthKey = $null
            Invoke-JoinCapturingFailure | Should Match "no auth key"
            $global:tailnetState = "Running"
        }
        It "reports 409 for a name known with another ID" {
            $Name = "taken"
            Invoke-JoinCapturingFailure | Should Match "409.*re-admit"
        }
        It "reports 403 for a caller outside the tailnet" {
            $Name = "stranger"
            Invoke-JoinCapturingFailure | Should Match "403"
        }
    }

    Describe "the host agent" {
        It "uses the host agent's Syncthing when the agent runs the node" {
            $node = Read-NodeFile $script:nodeRoot
            $status = Get-AgentStatusFolder $repository
            $heartbeatFile = Join-Path $status $agentHeartbeatName
            $saved = $null
            if (Test-Path $heartbeatFile) { $saved = [System.IO.File]::ReadAllText($heartbeatFile) }
            New-Item -ItemType Directory -Force -Path $status | Out-Null
            Write-JsonFile $heartbeatFile ([pscustomobject]@{
                state = "running"; heartbeatEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
                nodes = @([pscustomobject]@{ id = $node.id; syncthing = [pscustomobject]@{ state = "running"; guiPort = 8450; apiKey = "agent-key" } })
            })
            try {
                $instance = Get-NodeSyncthing $node
                $instance.owner | Should Be "agent"
                $instance.ports.gui | Should Be 8450
                $instance.apiKey | Should Be "agent-key"
            } finally {
                if ($saved) { [System.IO.File]::WriteAllText($heartbeatFile, $saved) } else { Remove-Item -Force $heartbeatFile }
            }
        }
    }
    Describe "adopting a Syncthing the device already runs" {
        $userSyncthingGuiPort = 18492
        $userSyncthingListenPort = 32192
        $Name = "adopted-pc"
        $script:adoptLetter = Get-FreeDriveLetter
        New-Item -ItemType Directory -Force -Path (Join-Path $scratch "volume2"), (Join-Path $scratch "winget"), (Join-Path $scratch "photos") | Out-Null
        & subst.exe "$($script:adoptLetter):" (Join-Path $scratch "volume2") | Out-Null
        $Root = "$($script:adoptLetter):\"
        $nodeHome = "$($Root).storage\syncthing"
        $oldHome = Join-Path $env:LOCALAPPDATA "Syncthing"
        $winget = Join-Path $scratch "winget\syncthing.exe"
        Copy-Item $script:syncthingPath $winget
        Add-TestFirewallGuard $winget
        & $winget generate "--home=$oldHome" --no-port-probing 2>&1 | Out-Null
        $config = [xml][System.IO.File]::ReadAllText((Join-Path $oldHome "config.xml"))
        $config.configuration.gui.address = "127.0.0.1:18484"
        foreach ($listen in @($config.configuration.options.SelectNodes("listenAddress"))) { $listen.InnerText = "tcp://0.0.0.0:32184" }
        $config.Save((Join-Path $oldHome "config.xml"))
        $old = Start-Process -FilePath $winget -ArgumentList "serve --no-browser --no-console" -WindowStyle Hidden -PassThru
        $oldKey = Get-ApiKey $oldHome
        $oldApi = { param($Method, $Path, $Body) $arguments = @{ Method = $Method; Uri = "http://127.0.0.1:18484$Path"; Headers = @{ "X-API-Key" = $oldKey }; UseBasicParsing = $true }; if ($Body) { $arguments["Body"] = $Body; $arguments["ContentType"] = "application/json" }; Invoke-RestMethod @arguments }
        $deadline = (Get-Date).AddSeconds(60)
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline) { try { & $oldApi "Get" "/rest/system/status" | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }
        if ($old.HasExited) { throw "the fake existing Syncthing exited with $($old.ExitCode)" }
        $deviceBefore = (& $oldApi "Get" "/rest/system/status").myID
        $peerId = (Invoke-Peer "Get" "/rest/system/status").myID
        & $oldApi "Put" "/rest/config/devices/$peerId" "{`"deviceID`": `"$peerId`", `"name`": `"old-peer`"}" | Out-Null
        & $oldApi "Put" "/rest/config/folders/photos" (ConvertTo-Json -Compress @{ id = "photos"; label = "photos"; path = (Join-Path $scratch "photos"); devices = @(@{ deviceID = $peerId }) }) | Out-Null
        Start-Sleep -Seconds 2
        $certificate = (Get-FileHash (Join-Path $oldHome "cert.pem")).Hash
        $global:tasks["Syncthing"] = [pscustomobject]@{ TaskName = "Syncthing"; TaskPath = "\"; Actions = @([pscustomobject]@{ Execute = $winget; Arguments = "serve --no-browser --no-console" }) }
        $global:taskCalls = @()
        $realBefore = @(Get-Process syncthing -ErrorAction SilentlyContinue | Where-Object { $_.Path -and -not $_.Path.StartsWith($scratch) -and $_.Path -ne $script:syncthingPath }).Count
        $outcome = Invoke-JoinCapturingFailure
        $adoptedKey = Get-ApiKey $nodeHome
        $adopted = { param($Path) Invoke-RestMethod -Uri "http://127.0.0.1:18492$Path" -Headers @{ "X-API-Key" = $adoptedKey } -UseBasicParsing }
        $deadline = (Get-Date).AddSeconds(60)
        while ((Get-Date) -lt $deadline) { try { & $adopted "/rest/system/status" | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }

        It "never sees this PC's own Syncthing home" { $oldHome.StartsWith($scratch) | Should Be $true }
        It "succeeds" { $outcome | Should Be "ok" }
        It "stops the old Syncthing" { $old.HasExited | Should Be $true }
        It "moves the home onto the node, certificate and key included" {
            Test-Path $oldHome | Should Be $false
            (Get-FileHash (Join-Path $nodeHome "cert.pem")).Hash | Should Be $certificate
            Test-Path (Join-Path $nodeHome "key.pem") | Should Be $true
        }
        It "keeps the device ID" { (& $adopted "/rest/system/status").myID | Should Be $deviceBefore }
        It "keeps its folders and devices" {
            (& $adopted "/rest/config/folders/photos").path | Should Be (Join-Path $scratch "photos")
            (& $adopted "/rest/config/devices/$peerId").name | Should Be "storage"
        }
        It "listens on the tailnet only, with its GUI on loopback" {
            @((& $adopted "/rest/config/options").listenAddresses) | Should Be @("tcp://127.0.0.1:32192")
            (& $adopted "/rest/config/gui").address | Should Be "127.0.0.1:18492"
        }
        It "removes the old logon task, after disabling it first" {
            ($global:taskCalls -join ",") | Should Be "disable Syncthing,unregister Syncthing"
            $global:tasks.ContainsKey("Syncthing") | Should Be $false
        }
        It "leaves the old executable installed" { Test-Path $winget | Should Be $true }
        It "leaves every other Syncthing on this PC running" {
            @(Get-Process syncthing -ErrorAction SilentlyContinue | Where-Object { $_.Path -and -not $_.Path.StartsWith($scratch) -and $_.Path -ne $script:syncthingPath }).Count | Should Be $realBefore
        }
        It "changes nothing when run again" {
            $script:joinChanges = 0
            Invoke-JoinCapturingFailure | Should Be "ok"
            $script:joinChanges | Should Be 0
        }
    }
    Describe "keeping everything is for the cluster only" {
        $fresh = Join-Path $scratch "fresh-root"
        New-Item -ItemType Directory -Force -Path $fresh | Out-Null
        $Root = $fresh

        It "refuses threshold 0 for a new device node, saying why and what to use" {
            $Threshold = 0
            { Assert-JoinThreshold } | Should Throw "use 50"
            Invoke-JoinCapturingFailure | Should Match "threshold 0 keeps everything.*STORAGE_JOIN_ALLOW_KEEP_ALL=1"
            Test-Path (Join-Path $fresh ".storage") | Should Be $false
        }
        It "allows it with STORAGE_JOIN_ALLOW_KEEP_ALL=1" {
            $Threshold = 0
            $env:STORAGE_JOIN_ALLOW_KEEP_ALL = "1"
            try { { Assert-JoinThreshold } | Should Not Throw } finally { Remove-Item Env:\STORAGE_JOIN_ALLOW_KEEP_ALL }
        }
        It "refuses an existing node file with threshold 0" {
            New-Item -ItemType Directory -Force -Path (Join-Path $fresh ".storage") | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $fresh ".storage\node.toml"), "[node]`nid = `"abcd`"`nname = `"old`"`nkind = `"folder`"`nthreshold = 0`n")
            { Assert-JoinThreshold } | Should Throw "use 50"
        }
        It "takes 50 when nothing says otherwise" {
            Remove-Item -Recurse -Force (Join-Path $fresh ".storage")
            $Threshold | Should Be 50
            { Assert-JoinThreshold } | Should Not Throw
        }
    }

    $script:folderLetter = Get-FreeDriveLetter
    New-Item -ItemType Directory -Force -Path (Join-Path $scratch "volume3") | Out-Null
    & subst.exe "$($script:folderLetter):" (Join-Path $scratch "volume3") | Out-Null
    $volume = "$($script:folderLetter):\"
    New-Item -ItemType Directory -Force -Path "$($volume)files", "$($volume)more", "$($volume)outer\in", "$($volume)node2", "$($script:nodeRoot)sub" | Out-Null

    Describe "when it asks" {
        It "asks on a console with no parameters and no STORAGE_JOIN_* set" {
            $global:terminal = $true
            Test-IsInteractiveJoin 0 | Should Be $true
        }
        It "does not with a parameter passed" {
            $global:terminal = $true
            Test-IsInteractiveJoin 1 | Should Be $false
        }
        It "does not with a STORAGE_JOIN_* set" {
            $global:terminal = $true
            $env:STORAGE_JOIN_THRESHOLD = "50"
            try { Test-IsInteractiveJoin 0 | Should Be $false } finally { Remove-Item Env:\STORAGE_JOIN_THRESHOLD }
        }
        It "does not with input redirected" {
            $global:terminal = $false
            Test-IsInteractiveJoin 0 | Should Be $false
        }
    }

    Describe "the three questions, answered from scripted input" {
        $savedRoot = $script:Root
        $savedThreshold = $script:Threshold
        $global:tailnetState = "Running"

        It "takes a drive root at 70 and joins" {
            $script:Root = $volume
            Invoke-Choices @("1", "", "70", "y") | Should Be "True"
            $script:Root | Should Be $volume
            $script:Threshold | Should Be 70
            $global:questions -contains "choose 1, 2 or 3 [1]" | Should Be $true
            $global:questions -contains "threshold, 0 to 100 (essential 80+, working 50+, archive 1+, 0 keeps everything) [50]" | Should Be $true
            $global:questions -contains "join the storage network now? [Y/n]" | Should Be $true
            $global:logLines -contains "  3) none: this device does not join the storage network" | Should Be $true
            $global:logLines -contains "threshold 70, keeps essential and working" | Should Be $true
        }
        It "keeps everything only when confirmed, on the second try" {
            $script:Threshold = 50
            Invoke-Choices @("2", "$($volume)files", "0", "n", "0", "y", "") | Should Be "True"
            $script:Root | Should Be "$($volume)files"
            $script:Threshold | Should Be 0
            $global:questions -contains "threshold 0 keeps EVERYTHING the storage network holds, backups and archives included. Keep everything? [y/N]" | Should Be $true
            $global:logLines -contains "the threshold was not changed" | Should Be $true
            $global:logLines -contains "threshold 0, keeps EVERYTHING, backups included" | Should Be $true
            { Assert-JoinThreshold } | Should Not Throw
        }
        It "answers none" {
            $script:Root = $volume
            Invoke-Choices @("3") | Should Be "False"
            $global:logLines -contains "no storage node chosen; this device does not join the storage network" | Should Be $true
        }
        It "offers none when the root is no drive root" {
            $script:Root = "$($volume)files"
            Invoke-Choices @("") | Should Be "False"
            $global:questions -contains "choose 1, 2 or 3 [3]" | Should Be $true
        }
        It "asks again for a drive root that is not one" {
            $script:Threshold = 50
            Invoke-Choices @("1", "$($volume)files", $volume.TrimEnd('\'), "", "") | Should Be "True"
            $script:Root | Should Be $volume
            ($global:logLines -join "|") | Should Match "is not a drive root.*choose it as a folder"
        }
        It "asks again for a folder that is relative, missing or a drive root" {
            Invoke-Choices @("2", "files", "$($volume)nothing", $volume, "$($volume)files\", "", "") | Should Be "True"
            $script:Root | Should Be "$($volume)files"
            ($global:logLines -join "|") | Should Match "a full path with its drive letter.*nothing does not exist.*is a drive root"
        }
        It "asks again for a threshold outside 0 to 100" {
            $script:Root = $volume
            Invoke-Choices @("1", "", "101", "high", "80", "") | Should Be "True"
            $script:Threshold | Should Be 80
            ($global:logLines -join "|") | Should Match "from 0 to 100, not '101'.*not 'high'"
        }
        It "stops when the join is answered no" {
            Invoke-Choices @("1", "", "", "n") | Should Be "False"
            $global:logLines -contains "not joining; run this again to join" | Should Be $true
        }
        It "offers no join without a key or the tailnet" {
            $global:tailnetState = "NeedsLogin"
            $AuthKey = $null
            Invoke-Choices @("1", "", "", "") | Should Be "False"
            $global:questions -contains "join the storage network now? [y/N]" | Should Be $true
            ($global:logLines -join "|") | Should Match "no Tailscale key"
            $global:tailnetState = "Running"
        }
        It "leaves an existing node's threshold, unasked" {
            Invoke-Choices @("1", $script:nodeRoot, "") | Should Be "True"
            $global:logLines -contains "$($script:nodeRoot).storage\node.toml keeps its threshold, 50" | Should Be $true
            @($global:questions | Where-Object { $_ -like "threshold*" }).Count | Should Be 0
        }
        It "fails when the input ends" {
            Invoke-Choices @("2") | Should Be "failed: no answer to: the folder that becomes the storage node (a full path)"
        }

        $script:Root = $savedRoot
        $script:Threshold = $savedThreshold
        $script:keepAllConfirmed = $false
    }

    Describe "a folder node is listed in its drive's index" {
        It "lists it" {
            $Root = "$($volume)files"
            Register-FolderNode
            @(Get-IndexPaths $volume) | Should Be @("files")
        }
        It "lists it once" {
            $Root = "$($volume)files"
            $script:joinChanges = 0
            Register-FolderNode
            $script:joinChanges | Should Be 0
            @(Get-IndexPaths $volume).Count | Should Be 1
        }
        It "adds a second one" {
            $Root = "$($volume)more"
            Register-FolderNode
            $Root = "$($volume)outer\in"
            Register-FolderNode
            [System.IO.File]::ReadAllText("$($volume).storage\nodes.toml") | Should Be "paths = [`"files`", `"more`", `"outer/in`"]`n"
        }
    }

    Describe "nested nodes are refused, and nothing is written" {
        It "refuses a folder inside a listed folder node" {
            $Root = "$($volume)files\inner"
            New-Item -ItemType Directory -Force -Path $Root | Out-Null
            Invoke-JoinCapturingFailure | Should Match ([regex]::Escape("$($volume)files\inner and $($volume)files are nested; a folder node cannot hold another"))
            Test-Path "$Root\.storage" | Should Be $false
        }
        It "refuses a folder holding a listed folder node" {
            $Root = "$($volume)outer"
            Invoke-JoinCapturingFailure | Should Match ([regex]::Escape("$($volume)outer and $($volume)outer\in are nested"))
        }
        It "refuses a folder on a drive node's drive" {
            $Root = "$($script:nodeRoot)sub"
            Invoke-JoinCapturingFailure | Should Match ([regex]::Escape("the drive $($script:nodeRoot) is a drive node"))
        }
        It "refuses a drive node over listed folder nodes" {
            $Root = $volume
            Invoke-JoinCapturingFailure | Should Match "lists folder nodes.*cannot be a drive node"
            Test-Path "$($volume).storage\node.toml" | Should Be $false
        }
    }

    Describe "joining a folder node end to end" {
        $userSyncthingGuiPort = 18494
        $userSyncthingListenPort = 32194
        $Name = "pc-files"
        $Root = "$($volume)node2"
        $script:joinChanges = 0
        $outcome = Invoke-JoinCapturingFailure

        It "succeeds" { $outcome | Should Be "ok" }
        It "writes a folder node file" { (Read-NodeFile $Root).kind | Should Be "folder" }
        It "lists it in the drive's index" { @(Get-IndexPaths $volume) | Should Be @("files", "more", "outer/in", "node2") }
        It "changes nothing when run again" {
            $script:joinChanges = 0
            Invoke-JoinCapturingFailure | Should Be "ok"
            $script:joinChanges | Should Be 0
            @(Get-IndexPaths $volume).Count | Should Be 4
        }
    }
} finally {
    Stop-Everything
}
