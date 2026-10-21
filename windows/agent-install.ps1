# Installing, repairing and removing the host agent service, and fetching its Syncthing. Dot-sourced by
# docker-compose.ps1 after agent-files.ps1 and disks.ps1; defines functions only.

$agentHeartbeatWaitSeconds = 120
$agentStopWaitSeconds = 60
$legacyAttachInstallFolder = Join-Path $env:ProgramFiles "storage-compose"
$nodeSyncthingTaskPrefix = "storage-compose syncthing"

function Test-IsElevated {
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-FileSha256([string]$Path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower() }

function Get-SyncthingDownloadUrl {
    $name = "syncthing-windows-$(Get-SyncthingArchitecture)-$syncthingVersion"
    return "https://github.com/syncthing/syncthing/releases/download/$syncthingVersion/$name.zip"
}

<#
.NOTES
Fetched once into the stack folder and kept there, since the house connection is slow; the archive
is checked against the hash pinned in agent-files.ps1 before anything in it is used.
#>
function Get-SyncthingBinary([string]$StackFolder) {
    $binary = Get-SyncthingPath $StackFolder
    if (Test-Path -LiteralPath $binary) { return $binary }
    $folder = Get-SyncthingFolder $StackFolder
    $download = "$folder.download"
    Remove-Item -Recurse -Force -LiteralPath $download -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $download | Out-Null
    $archive = Join-Path $download "syncthing.zip"
    $previousProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri (Get-SyncthingDownloadUrl) -OutFile $archive
    } finally { $ProgressPreference = $previousProgress }
    $expected = $syncthingArchiveHashes[(Get-SyncthingArchitecture)]
    $actual = Get-FileSha256 $archive
    if ($actual -ne $expected) {
        Remove-Item -Recurse -Force -LiteralPath $download
        throw "the Syncthing download has SHA-256 $actual, not the pinned $expected; nothing was installed"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $download
    $extracted = Get-ChildItem -LiteralPath $download -Recurse -Filter "syncthing.exe" | Select-Object -First 1
    if (-not $extracted) { throw "the Syncthing archive holds no syncthing.exe" }
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    Move-Item -LiteralPath $extracted.FullName -Destination $binary
    Remove-Item -Recurse -Force -LiteralPath $download
    return $binary
}

function Get-AgentSourceFolder([string]$StackFolder) { return Join-Path $StackFolder "windows" }

function Get-DesiredAgentConfig([string]$StackFolder, [string]$ProjectName, [string]$PassThrough, [string]$SyncthingPath, [int]$GraceSeconds) {
    return [pscustomobject][ordered]@{
        stackFolder = $StackFolder.TrimEnd('\')
        projectName = $ProjectName
        userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        passThrough = $PassThrough
        syncthingPath = $SyncthingPath
        syncthingSha256 = Get-FileSha256 $SyncthingPath
        serviceSourceSha256 = Get-FileSha256 (Join-Path (Get-AgentSourceFolder $StackFolder) $agentServiceSourceName)
        graceSeconds = $GraceSeconds
    }
}

function ConvertTo-ComparableJson($Value) { return ConvertTo-Json -InputObject $Value -Depth 5 -Compress }

function Test-InstalledScriptsAreCurrent([string]$StackFolder) {
    foreach ($name in $agentScriptNames) {
        $installed = Join-Path $agentInstallFolder $name
        if (-not (Test-Path -LiteralPath $installed)) { return $false }
        if ((Get-FileSha256 $installed) -ne (Get-FileSha256 (Join-Path (Get-AgentSourceFolder $StackFolder) $name))) { return $false }
    }
    return Test-Path -LiteralPath (Join-Path $agentInstallFolder $agentExecutableName)
}

function Get-AgentService { return Get-CimInstance Win32_Service -Filter "Name='$agentServiceName'" -ErrorAction SilentlyContinue }

function Get-AgentServiceCommandLine {
    $executable = Join-Path $agentInstallFolder $agentExecutableName
    $config = Join-Path $agentInstallFolder $agentConfigName
    return "`"$executable`" -ConfigFile `"$config`""
}

function Get-AgentHeartbeat([string]$StackFolder) {
    return Read-JsonFile (Join-Path (Get-AgentStatusFolder $StackFolder) $agentHeartbeatName)
}

function Test-AgentHeartbeatIsFresh([string]$StackFolder, [int]$Seconds = 30) {
    $heartbeat = Get-AgentHeartbeat $StackFolder
    if (-not ($heartbeat -and $heartbeat.PSObject.Properties["heartbeatEpoch"] -and $heartbeat.state -eq "running")) { return $false }
    return ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$heartbeat.heartbeatEpoch) -lt $Seconds
}

function Test-HostAgentIsCurrent($Desired) {
    $service = Get-AgentService
    if (-not $service -or $service.State -ne "Running" -or $service.PathName -ne (Get-AgentServiceCommandLine)) { return $false }
    if (-not (Test-InstalledScriptsAreCurrent $Desired.stackFolder)) { return $false }
    $installed = Read-JsonFile (Join-Path $agentInstallFolder $agentConfigName)
    if (-not $installed) { return $false }
    return (ConvertTo-ComparableJson $installed) -eq (ConvertTo-ComparableJson $Desired)
}

function Wait-ForServiceProcessExit([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    $deadline = (Get-Date).AddSeconds($agentStopWaitSeconds)
    while ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-AgentService {
    $service = Get-AgentService
    if (-not $service) { return }
    $processId = [int]$service.ProcessId
    if ($service.State -ne "Stopped") { Stop-Service -Name $agentServiceName -Force -NoWait -ErrorAction SilentlyContinue }
    Wait-ForServiceProcessExit $processId
}

<#
.NOTES
Compiled in a child process: Add-Type loads what it compiles, and a loaded executable stays locked
until the process ends, which would block the next reinstall from this shell.
#>
function Build-AgentExecutable([string]$Source, [string]$Output) {
    $script = "Add-Type -TypeDefinition ([IO.File]::ReadAllText('$($Source -replace "'", "''")')) -Language CSharp -OutputAssembly '$($Output -replace "'", "''")' -OutputType ConsoleApplication -ReferencedAssemblies System.ServiceProcess"
    & powershell.exe -NoProfile -NonInteractive -Command $script
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) { throw "the agent service could not be compiled from $Source" }
}

function Copy-AgentFiles($Desired) {
    New-Item -ItemType Directory -Force -Path $agentInstallFolder | Out-Null
    $sourceFolder = Get-AgentSourceFolder $Desired.stackFolder
    foreach ($name in $agentScriptNames) { Copy-Item -Force -LiteralPath (Join-Path $sourceFolder $name) -Destination (Join-Path $agentInstallFolder $name) }
    $executable = Join-Path $agentInstallFolder $agentExecutableName
    $installed = Read-JsonFile (Join-Path $agentInstallFolder $agentConfigName)
    $isBuilt = (Test-Path -LiteralPath $executable) -and $installed -and $installed.PSObject.Properties["serviceSourceSha256"] -and $installed.serviceSourceSha256 -eq $Desired.serviceSourceSha256
    if (-not $isBuilt) { Build-AgentExecutable (Join-Path $sourceFolder $agentServiceSourceName) $executable }
    Write-JsonFile (Join-Path $agentInstallFolder $agentConfigName) $Desired
}

function Invoke-ServiceControl([string[]]$Arguments) {
    $output = & sc.exe @Arguments 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "sc.exe $($Arguments[0]) failed: $($output -join ' ')" }
}

<#
.NOTES
New-Service rather than `sc.exe create`: Windows PowerShell 5.1 drops the inner quotes of a native
argument, which breaks the quoted binPath. A registered service is deleted and created again, since
Set-Service cannot change the path in 5.1.
#>
function Register-AgentService {
    if (Get-AgentService) {
        Invoke-ServiceControl @("delete", $agentServiceName)
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-AgentService) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    }
    New-Service -Name $agentServiceName -BinaryPathName (Get-AgentServiceCommandLine) -DisplayName $agentServiceDisplayName -StartupType Automatic `
        -Description "Passes the storage array's drives through to WSL and runs the drive and folder nodes' Syncthing while storage-compose runs; removes itself when the stack is gone." | Out-Null
    Invoke-ServiceControl @("failure", $agentServiceName, "reset=", "86400", "actions=", "restart/10000/restart/10000/restart/60000")
}

function Wait-ForAgentHeartbeat([string]$StackFolder) {
    $deadline = (Get-Date).AddSeconds($agentHeartbeatWaitSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-AgentHeartbeatIsFresh $StackFolder) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

<#
.NOTES
`up` calls this every time: an agent that is installed, current and running is left alone, so `up`
needs an admin shell only to install or repair it.
#>
function Install-HostAgent([string]$StackFolder, [string]$ProjectName, [string]$PassThrough, [int]$GraceSeconds = 600) {
    $syncthing = Get-SyncthingBinary $StackFolder
    $desired = Get-DesiredAgentConfig $StackFolder $ProjectName $PassThrough $syncthing $GraceSeconds
    if ((Test-HostAgentIsCurrent $desired) -and (Wait-ForAgentHeartbeat $StackFolder)) { return "current" }
    if (-not (Test-IsElevated)) { throw "the host agent is missing, outdated or stopped; run up once in an admin shell to install it" }
    Stop-AgentService
    Copy-AgentFiles $desired
    Register-AgentService
    Start-Service -Name $agentServiceName
    if (-not (Wait-ForAgentHeartbeat $StackFolder)) { throw "the host agent was installed but wrote no heartbeat within $agentHeartbeatWaitSeconds s; see $agentFolderName\$agentLogName and $agentInstallFolder\service.log" }
    return "installed"
}

function Stop-StackSyncthings([string]$StackFolder) {
    $binary = Get-SyncthingPath $StackFolder
    Get-CimInstance Win32_Process -Filter "Name='syncthing.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq $binary } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Uninstall-HostAgent([string]$StackFolder) {
    if (-not (Get-AgentService) -and -not (Test-Path -LiteralPath $agentInstallFolder)) { return "absent" }
    if (-not (Test-IsElevated)) { throw "removing the host agent needs an admin shell; left alone, it removes itself 10 minutes after the stack is gone" }
    Stop-AgentService
    if (Get-AgentService) { Invoke-ServiceControl @("delete", $agentServiceName) }
    Stop-StackSyncthings $StackFolder
    Remove-NetFirewallRule -Group $agentFirewallGroup -ErrorAction SilentlyContinue
    Remove-ProgramFirewallRules (Join-Path (Get-AgentFolder $StackFolder) "bin")
    Remove-Item -Recurse -Force -LiteralPath $agentInstallFolder -ErrorAction SilentlyContinue
    return "removed"
}

<#
.NOTES
The logon task of specs/2026-10-11-wsl-passthrough.md is replaced by the service; both reading one
request file would pass the same drives through twice.
#>
function Remove-LegacyAttachTask {
    $task = Get-ScheduledTask -TaskName $legacyAttachTaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $false }
    if (-not (Test-IsElevated)) { throw "the old attach task '$legacyAttachTaskName' is still registered; run up once in an admin shell to replace it" }
    Stop-ScheduledTask -TaskName $legacyAttachTaskName -ErrorAction SilentlyContinue
    $watcher = [regex]::Escape((Join-Path $legacyAttachInstallFolder "watcher.ps1"))
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match $watcher } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Unregister-ScheduledTask -TaskName $legacyAttachTaskName -Confirm:$false
    Remove-Item -Recurse -Force -LiteralPath $legacyAttachInstallFolder -ErrorAction SilentlyContinue
    return $true
}

function Get-NodeSyncthingTaskArguments([string]$SyncthingHome) {
    return "serve --home=`"$SyncthingHome`" --no-browser --no-restart --no-upgrade --log-file=`"$([System.IO.Path]::Combine($SyncthingHome, 'syncthing.log'))`" --log-max-size=$syncthingLogMaxBytes --log-max-old-files=2"
}

function Get-TaskSyncthingHome($Task) {
    $action = @($Task.Actions | Where-Object { $_ -and $_.PSObject.Properties["Arguments"] })[0]
    if ($action -and "$($action.Arguments)" -match '--home="([^"]+)"') { return $Matches[1] }
    return $null
}

function Get-AgentNodeHomes([string]$StackFolder) {
    $heartbeat = Get-AgentHeartbeat $StackFolder
    if (-not ($heartbeat -and $heartbeat.PSObject.Properties["foundNodes"])) { return @() }
    return @($heartbeat.foundNodes | Where-Object { $_ -and $_.root } | ForEach-Object { [System.IO.Path]::Combine($_.root, ".storage\syncthing").TrimEnd('\') })
}

<#
.NOTES
The join registers such a task on a device without the agent. Once the agent runs the node, the task
would start a second Syncthing on the same home at the next logon, so it goes; only a task of the
join's name prefix whose home is a node the agent found is touched.
#>
function Remove-AgentNodeSyncthingTasks([string]$StackFolder) {
    $homes = @(Get-AgentNodeHomes $StackFolder)
    if ($homes.Count -eq 0) { return @() }
    $removed = @()
    foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.TaskName -like "$nodeSyncthingTaskPrefix *" })) {
        $taskHome = Get-TaskSyncthingHome $task
        if (-not ($taskHome -and @($homes | Where-Object { $_ -ieq $taskHome.TrimEnd('\') }).Count -gt 0)) { continue }
        Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false
        $removed += $task.TaskName
    }
    return $removed
}
