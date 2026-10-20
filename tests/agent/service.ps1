#Requires -Version 5.1
<#
.SYNOPSIS
The one test that registers the real service, run only on request (run.ps1 -Service): installs the
agent for a copy of this stack under a test project name, with the pass-through off so no disk of
this PC can be passed through, and checks it as SYSTEM end to end: the relay runs wsl.exe as this
user (a VHDX through `wsl --mount --vhd`), a VHDX drive node gets a SYSTEM Syncthing that a container
reaches at host.docker.internal, the agent removes itself once the test container is gone, and `down`'s
uninstall leaves nothing. Needs an admin shell and Docker Desktop; cleans up after itself.
#>
param([Parameter(Mandatory = $true)][string]$SyncthingPath)

Set-StrictMode -Version Latest
$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\disks.ps1")
. (Join-Path $repository "windows\agent-files.ps1")
. (Join-Path $repository "windows\agent-install.ps1")
. (Join-Path $PSScriptRoot "test-volumes.ps1")

$project = "storage-agent-test"
$graceSeconds = 60
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-service-$([guid]::NewGuid())"
$stack = Join-Path $scratch "storage-compose"
$nodeVhdx = Join-Path $scratch "service-node.vhdx"
$wslVhdx = Join-Path $scratch "service-wsl.vhdx"
$probeContainer = "storage-agent-test-probe"
$relayTask = "storage-agent-test relay"
$script:passed = 0
$script:failed = 0

function Test-Expectation([string]$What, $Expected, $Actual) {
    if ("$Expected" -eq "$Actual") { Write-Host "  PASS $What`: $Actual" -ForegroundColor Green; $script:passed++ }
    else { Write-Host "  FAIL $What`: expected '$Expected', got '$Actual'" -ForegroundColor Red; $script:failed++ }
}

function New-StackCopy {
    New-Item -ItemType Directory -Force -Path (Join-Path $stack "windows\service"), (Get-SyncthingFolder $stack) | Out-Null
    foreach ($name in $agentScriptNames + @($agentServiceSourceName)) { Copy-Item (Join-Path $repository "windows\$name") (Join-Path $stack "windows\$name") }
    Copy-Item (Join-Path $repository "docker-compose.yml") $stack
    Copy-Item $SyncthingPath (Get-SyncthingPath $stack)
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) { if (& $Condition) { return $true }; Start-Sleep -Seconds 2 }
    return $false
}

function Get-Heartbeat { return Get-AgentHeartbeat $stack }

function Get-HeartbeatNode([string]$Id) {
    $heartbeat = Get-Heartbeat
    if (-not $heartbeat) { return $null }
    return @($heartbeat.nodes | Where-Object { $_.id -eq $Id -and $_.syncthing.state -eq "running" }) | Select-Object -First 1
}

<#
.NOTES
Runs the installed relay from a SYSTEM scheduled task, the same account and privileges the service
has, and returns its exit code and output.
#>
function Invoke-RelayAsSystem([string[]]$Command) {
    $output = Join-Path $scratch "relay-$([guid]::NewGuid()).txt"
    $relay = Join-Path $agentInstallFolder $agentExecutableName
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $line = "`"$relay`" run-as-user $sid 120 --env WSL_UTF8=1 -- $($Command -join ' ') > `"$output`" 2>&1 & call echo exit=%^errorlevel%>> `"$output`""
    $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/s /c `"$line`""
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $relayTask -Action $action -Principal $principal -Force | Out-Null
    try {
        Start-ScheduledTask -TaskName $relayTask
        Wait-Until { (Test-Path $output) -and ((Get-Content -Raw $output) -match "exit=") } 180 | Out-Null
    } finally { Unregister-ScheduledTask -TaskName $relayTask -Confirm:$false -ErrorAction SilentlyContinue }
    $text = if (Test-Path $output) { Get-Content -Raw $output } else { "" }
    $exit = if ($text -match "exit=(-?\d+)") { [int]$Matches[1] } else { $null }
    return [pscustomobject]@{ ExitCode = $exit; Output = ($text -replace "exit=-?\d+", "").Trim() }
}

function Test-NothingLeft([string]$When) {
    Test-Expectation "$When`: service registered" $false ([bool](Get-AgentService))
    Test-Expectation "$When`: install folder" $false (Test-Path $agentInstallFolder)
    Test-Expectation "$When`: firewall rules" 0 @(Get-NetFirewallRule -Group $agentFirewallGroup -ErrorAction SilentlyContinue).Count
    $bin = Join-Path (Get-AgentFolder $stack) "bin"
    Test-Expectation "$When`: any rule for a binary in host-agent\bin" 0 @(Get-NetFirewallApplicationFilter -All | Where-Object { $_.Program -and $_.Program -ne "Any" -and (Test-IsPathUnder $_.Program $bin) }).Count
    $binary = Get-SyncthingPath $stack
    Test-Expectation "$When`: Syncthing processes" 0 @(Get-CimInstance Win32_Process -Filter "Name='syncthing.exe'" | Where-Object { $_.ExecutablePath -eq $binary }).Count
}

if (Get-AgentService) { Write-Host "A storage-compose-agent service is already registered; this test does not replace it." -ForegroundColor Red; exit 1 }

try {
    New-StackCopy
    Write-Host "Installing the service for a running test stack (pass-through off)..." -ForegroundColor Cyan
    & docker run -d --name $probeContainer --label "com.docker.compose.project=$project" debian:trixie-slim sleep infinity | Out-Null
    Test-Expectation "install" "installed" (Install-HostAgent $stack $project "none" $graceSeconds)
    $service = Get-AgentService
    Test-Expectation "runs as" "LocalSystem" $service.StartName
    Test-Expectation "starts" "Auto" $service.StartMode
    Test-Expectation "heartbeat fresh" $true (Test-AgentHeartbeatIsFresh $stack)
    Test-Expectation "acts while a container of the project runs" $true (Wait-Until { (Get-Heartbeat).stack.active } 30)
    Test-Expectation "a second up finds it current" "current" (Install-HostAgent $stack $project "none" $graceSeconds)

    Write-Host "The relay, as SYSTEM, runs wsl.exe as this user:" -ForegroundColor Cyan
    $list = Invoke-RelayAsSystem @("wsl.exe", "--list", "--running", "--quiet")
    Test-Expectation "wsl --list exit code" 0 $list.ExitCode
    Test-Expectation "sees this user's Docker Desktop distribution" $true ($list.Output -split "\s+" -contains "docker-desktop")
    Invoke-Diskpart @("create vdisk file=`"$wslVhdx`" maximum=16 type=expandable") | Out-Null
    $mount = Invoke-RelayAsSystem @("wsl.exe", "--mount", "--vhd", "`"$wslVhdx`"", "--bare")
    Test-Expectation "wsl --mount --vhd (needs the elevated token) exit code" 0 $mount.ExitCode
    $unmount = Invoke-RelayAsSystem @("wsl.exe", "--unmount", "`"$wslVhdx`"")
    Test-Expectation "wsl --unmount exit code" 0 $unmount.ExitCode

    Write-Host "A drive node while the stack runs:" -ForegroundColor Cyan
    $nodeRoot = New-TestVolume $nodeVhdx "agentsvc"
    Write-TestNodeFile $nodeRoot "5e7a" "service-test" "drive"
    Test-Expectation "the node's Syncthing runs" $true (Wait-Until { [bool](Get-HeartbeatNode "5e7a") } 120)
    $node = Get-HeartbeatNode "5e7a"
    if ($node) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($node.syncthing.processId)"
        Test-Expectation "Syncthing runs as" "SYSTEM" (Invoke-CimMethod -InputObject $process -MethodName GetOwner).User
        Test-Expectation "its home is on the node" (Join-Path $nodeRoot ".storage\syncthing") $node.syncthing.home
        Test-Expectation "its sync port" 22001 $node.syncthing.listenPort
        $rule = Get-NetFirewallRule -Name "storage-compose syncthing 5e7a" -ErrorAction SilentlyContinue
        Test-Expectation "its port is open to the tailnet only" "100.64.0.0/255.192.0.0" $(if ($rule) { ($rule | Get-NetFirewallAddressFilter).RemoteAddress } else { "no rule" })
        $script = "import json,sys,urllib.request,time`nfor attempt in range(60):`n    try:`n        request = urllib.request.Request('http://host.docker.internal:$($node.syncthing.guiPort)/rest/system/status', headers={'X-API-Key': '$($node.syncthing.apiKey)'})`n        print(json.load(urllib.request.urlopen(request, timeout=5))['myID']); sys.exit(0)`n    except Exception:`n        time.sleep(1)`nsys.exit(1)"
        [System.IO.File]::WriteAllText((Join-Path $scratch "probe.py"), $script)
        $fromContainer = (& docker run --rm --add-host "host.docker.internal:host-gateway" -v "${scratch}:/probe:ro" python:3.13-alpine python /probe/probe.py 2>&1 | Select-Object -Last 1)
        Test-Expectation "a container reaches its API at host.docker.internal" $node.syncthing.deviceId "$fromContainer"
    }

    New-NetFirewallRule -DisplayName "Syncthing - as Windows makes it after its prompt (test)" -Program (Get-SyncthingPath $stack).ToLower() `
        -Direction Inbound -Action Allow -Protocol TCP -Enabled False -Profile Any | Out-Null

    Write-Host "The stack goes away without down:" -ForegroundColor Cyan
    & docker rm -f $probeContainer | Out-Null
    Test-Expectation "the node's Syncthing stops within a round or two" $true (Wait-Until { -not (Get-HeartbeatNode "5e7a") } 30)
    $removed = Wait-Until { -not (Get-AgentService) -and -not (Test-Path $agentInstallFolder) } ($graceSeconds + 120)
    Test-Expectation "the agent removed itself after the grace period" $true $removed
    Test-Expectation "its last heartbeat says so" "removed" (Get-Heartbeat).state
    Test-NothingLeft "after removing itself"

    Write-Host "down's uninstall:" -ForegroundColor Cyan
    Test-Expectation "install again" "installed" (Install-HostAgent $stack $project "none" $graceSeconds)
    Test-Expectation "uninstall" "removed" (Uninstall-HostAgent $stack)
    Test-NothingLeft "after down"
} finally {
    & docker rm -f $probeContainer 2>$null | Out-Null
    Uninstall-HostAgent $stack | Out-Null
    Unregister-ScheduledTask -TaskName $relayTask -Confirm:$false -ErrorAction SilentlyContinue
    Remove-TestVolume $nodeVhdx
    if (Test-Path $wslVhdx) { & wsl.exe --unmount $wslVhdx 2>$null | Out-Null; Remove-Item -Force $wslVhdx -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
}
Write-Host ""
Write-Host "Service: $script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
