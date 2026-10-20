# Pester 3.4: the Windows join script against the fake dashboard (tests/join/fake-dashboard.py), which
# admits the device into a real Syncthing peer, with the device's own real Syncthing. Tailscale and the
# scheduled task are faked (the task starts the process directly); the node is a subst drive over a
# temporary folder, so neither F:\ nor the tailnet is touched. Needs python on the PATH.

param([string]$Python = "python")

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "join\storage-join.ps1")
. (Join-Path $PSScriptRoot "..\agent\test-volumes.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "join-windows-$([guid]::NewGuid())"
$userSyncthingGuiPort = 18490
$userSyncthingListenPort = 32190
$peerGuiPort = 18491
$dashboardPort = 18099
$tailscaleCli = Join-Path $scratch "fake\tailscale.exe"
$global:tailnetState = "NeedsLogin"
$global:tailscaleUps = @()
$global:tasks = @{}
$global:registrations = 0
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
function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName);  return $global:tasks[$TaskName] }
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument);  return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument } }
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn, [string]$User);  return "at logon of $User" }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param($ExecutionTimeLimit, $RestartCount, $RestartInterval, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries);  return "settings" }
function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName, $Action, $Trigger, $Settings, [switch]$Force); 
    $global:tasks[$TaskName] = [pscustomobject]@{ Actions = @($Action) }
    $global:registrations++
}
function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName); 
    $action = $global:tasks[$TaskName].Actions[0]
    Start-Process -FilePath $action.Execute -ArgumentList $action.Arguments -WindowStyle Hidden
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
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}

function Invoke-JoinCapturingFailure {
    try { Invoke-Join 6>$null; return "ok" } catch { return "$_" }
}

function Get-RequestLines { return @(Get-Content (Join-Path $scratch "dashboard\requests.jsonl")) }

New-Item -ItemType Directory -Force -Path (Split-Path $tailscaleCli), (Join-Path $scratch "volume") | Out-Null
Set-Content -Path $tailscaleCli -Value "fake"
$script:syncthingPath = Get-SyncthingBinary $repository
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

    Describe "the first run" {
        $outcome = Invoke-JoinCapturingFailure

        It "succeeds" { $outcome | Should Be "ok" }
        It "joins the tailnet with the key and the device name" { $global:tailscaleUps | Should Be @("up --auth-key=tskey-test --hostname=pc-test --unattended") }
        It "writes a drive node file at the volume root" {
            $node = Read-NodeFile $script:nodeRoot
            $node.kind | Should Be "drive"
            $node.name | Should Be "pc-test"
            $node.id | Should Match '^[0-9a-f]{4}$'
        }
        It "runs Syncthing at logon from a task, with its home on the node" {
            $task = $global:tasks["storage-compose syncthing pc-test"]
            $task.Actions[0].Execute | Should Be $script:syncthingPath
            $task.Actions[0].Arguments | Should Match ([regex]::Escape("--home=`"$($script:nodeRoot).storage\syncthing`""))
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

    Describe "a folder node and the host agent" {
        It "lists a folder node in its volume's index" {
            $Root = "$($script:nodeRoot)files"
            New-Item -ItemType Directory -Force -Path $Root | Out-Null
            Register-FolderNode
            (Read-TomlFile "$($script:nodeRoot).storage\nodes.toml")[""]["paths"] | Should Be @("files")
            Register-FolderNode
            @((Read-TomlFile "$($script:nodeRoot).storage\nodes.toml")[""]["paths"]).Count | Should Be 1
        }
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
} finally {
    Stop-Everything
}
