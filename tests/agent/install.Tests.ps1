# Pester 3.4: fetching Syncthing, building the service host and deciding whether the installed agent
# is current, against a temporary install folder and a fake download and service manager. Nothing
# here registers a service or touches Program Files.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\disks.ps1")
. (Join-Path $repository "windows\agent-files.ps1")
. (Join-Path $repository "windows\nodes.ps1")
. (Join-Path $repository "windows\agent-install.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-install-$([guid]::NewGuid())"
$agentInstallFolder = Join-Path $scratch "Program Files\storage-compose-agent"
$agentServiceName = "storage-compose-agent-test-never-installed"
$agentFirewallGroup = "storage-compose test group"
$global:downloads = @()
$global:fakeService = $null

function Invoke-WebRequest([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing) {
    $global:downloads += $Uri
    Copy-Item -LiteralPath $global:archiveToServe -Destination $OutFile
}
function Get-AgentService { return $global:fakeService }

function New-FakeArchive([string]$Content) {
    $source = Join-Path $scratch "archive-source\syncthing-windows-amd64-$syncthingVersion"
    New-Item -ItemType Directory -Force -Path $source | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $source "syncthing.exe"), $Content)
    $archive = Join-Path $scratch "fake-$([guid]::NewGuid()).zip"
    Compress-Archive -Path (Split-Path $source) -DestinationPath $archive
    Remove-Item -Recurse -Force (Split-Path $source)
    return $archive
}

function New-StackCopy {
    $stack = Join-Path $scratch "stack"
    New-Item -ItemType Directory -Force -Path (Join-Path $stack "windows\service") | Out-Null
    foreach ($name in $agentScriptNames + @($agentServiceSourceName)) {
        Copy-Item -LiteralPath (Join-Path $repository "windows\$name") -Destination (Join-Path $stack "windows\$name")
    }
    Set-Content -Path (Join-Path $stack "docker-compose.yml") -Value "name: storage-compose"
    return $stack
}

Describe "fetching Syncthing" {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $stack = New-StackCopy
    $realHashes = $syncthingArchiveHashes.Clone()

    It "refuses an archive whose hash is not the pinned one and leaves nothing behind" {
        $global:archiveToServe = New-FakeArchive "tampered"
        { Get-SyncthingBinary $stack } | Should Throw "not the pinned"
        Test-Path (Get-SyncthingFolder $stack) | Should Be $false
        Test-Path "$(Get-SyncthingFolder $stack).download" | Should Be $false
    }

    It "takes the binary from an archive with the pinned hash" {
        $global:archiveToServe = New-FakeArchive "genuine"
        $syncthingArchiveHashes[(Get-SyncthingArchitecture)] = (Get-FileHash -Algorithm SHA256 $global:archiveToServe).Hash.ToLower()
        $binary = Get-SyncthingBinary $stack
        $binary | Should Be (Get-SyncthingPath $stack)
        [System.IO.File]::ReadAllText($binary) | Should Be "genuine"
        $global:downloads[-1] | Should Be "https://github.com/syncthing/syncthing/releases/download/$syncthingVersion/syncthing-windows-amd64-$syncthingVersion.zip"
    }

    It "downloads only once" {
        $count = $global:downloads.Count
        Get-SyncthingBinary $stack | Out-Null
        $global:downloads.Count | Should Be $count
    }

    It "pins the version the stack's container runs" {
        $compose = Get-Content -Raw (Join-Path $repository "docker-compose.yml")
        $compose | Should Match ([regex]::Escape("ghcr.io/syncthing/syncthing:$($syncthingVersion.TrimStart('v'))"))
        $realHashes["amd64"] | Should Match '^[0-9a-f]{64}$'
    }
}

Describe "the service host" {
    $executable = Join-Path $scratch "build\storage-compose-agent.exe"
    New-Item -ItemType Directory -Force -Path (Split-Path $executable) | Out-Null
    Build-AgentExecutable (Join-Path $repository "windows\$agentServiceSourceName") $executable

    It "compiles from its source with what ships with Windows" {
        Test-Path $executable | Should Be $true
    }

    It "refuses a relay request without a program" {
        & $executable run-as-user "S-1-5-21-1" 10 --env WSL_UTF8=1 -- 2>$null
        $LASTEXITCODE | Should Be 71
    }

    It "answers 70 for a user without a session, which the agent reads as WSL being unavailable" {
        & $executable run-as-user "S-1-5-21-0-0-0-1" 10 -- cmd.exe /c echo hi 2>$null
        $LASTEXITCODE | Should Be 70
    }
}

Describe "whether the installed agent is current" {
    $stack = New-StackCopy
    $binary = Get-SyncthingPath $stack
    $desired = Get-DesiredAgentConfig $stack "storage-compose" "wsl" $binary 600

    It "is not while no service is registered" {
        $global:fakeService = $null
        Test-HostAgentIsCurrent $desired | Should Be $false
    }

    It "is when the service runs the installed copy with the same config and scripts" {
        Copy-AgentFiles $desired
        $global:fakeService = [pscustomobject]@{ State = "Running"; PathName = (Get-AgentServiceCommandLine); ProcessId = 0 }
        Test-HostAgentIsCurrent $desired | Should Be $true
    }

    It "is not once a script in the checkout changed" {
        Add-Content -Path (Join-Path $stack "windows\nodes.ps1") -Value "# changed"
        Test-HostAgentIsCurrent $desired | Should Be $false
        Copy-AgentFiles $desired
        Test-HostAgentIsCurrent $desired | Should Be $true
    }

    It "is not for another user, another mode or another stack folder" {
        $other = Get-DesiredAgentConfig $stack "storage-compose" "none" $binary 600
        Test-HostAgentIsCurrent $other | Should Be $false
        $desired.userSid = "S-1-5-21-0"
        Test-HostAgentIsCurrent $desired | Should Be $false
    }

    It "is not while the service is stopped" {
        $global:fakeService = [pscustomobject]@{ State = "Stopped"; PathName = (Get-AgentServiceCommandLine); ProcessId = 0 }
        Test-HostAgentIsCurrent (Get-DesiredAgentConfig $stack "storage-compose" "wsl" $binary 600) | Should Be $false
    }

    It "is rebuilt only when the service source changed" {
        $executable = Join-Path $agentInstallFolder $agentExecutableName
        $before = (Get-Item $executable).LastWriteTimeUtc
        Copy-AgentFiles (Get-DesiredAgentConfig $stack "storage-compose" "wsl" $binary 600)
        (Get-Item $executable).LastWriteTimeUtc | Should Be $before
    }
}

Describe "install and removal without an admin shell" {
    $stack = New-StackCopy
    function Test-IsElevated { return $false }

    It "refuses to install and says how" {
        $global:fakeService = $null
        { Install-HostAgent $stack "storage-compose" "wsl" } | Should Throw "admin shell"
    }

    It "has nothing to remove when nothing is installed" {
        $global:fakeService = $null
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $agentInstallFolder
        Uninstall-HostAgent $stack | Should Be "absent"
    }
}

function New-JoinedRoot([string]$Name, [switch]$WithNodeFile) {
    $root = Join-Path $scratch "joined\$Name"
    New-Item -ItemType Directory -Force -Path (Join-Path $root ".storage") | Out-Null
    if ($WithNodeFile) { Set-Content -Path (Join-Path $root ".storage\node.toml") -Value "[node]`nid = `"a001`"`nname = `"laptop`"`nkind = `"drive`"" }
    return $root
}

function Write-InstalledConfig([string]$ProjectName, [object[]]$JoinedNodes) {
    New-Item -ItemType Directory -Force -Path $agentInstallFolder | Out-Null
    Write-JsonFile (Join-Path $agentInstallFolder $agentConfigName) ([pscustomobject]@{ stackFolder = "C:\elsewhere"; projectName = $ProjectName; joinedNodes = @($JoinedNodes) })
}

Describe "the joined nodes in the agent's config" {
    $stack = New-StackCopy
    $binary = Join-Path $scratch "syncthing-for-config.exe"
    Set-Content -Path $binary -Value "binary"
    function Get-SyncthingBinary([string]$StackFolder) { return $binary }
    function Install-AgentService($Desired, [string]$ElevationHint) { $global:desired = $Desired; return "installed" }
    $kept = New-JoinedRoot "kept" -WithNodeFile
    $left = New-JoinedRoot "left"

    It "up installs stack mode and carries the installed joined nodes as they are" {
        Write-InstalledConfig "" @([pscustomobject]@{ root = $left; dashboard = "https://storage.tail-test.ts.net" })
        Install-HostAgent $stack "storage-compose" "wsl" | Should Be "installed"
        Get-AgentMode $global:desired | Should Be "stack"
        @($global:desired.joinedNodes | ForEach-Object { $_.root }) | Should Be @($left)
    }

    It "a join installs joined mode and adds its node to the remaining ones, once per root" {
        Write-InstalledConfig "" @(
            [pscustomobject]@{ root = $kept; dashboard = "https://old.tail-test.ts.net" },
            [pscustomobject]@{ root = $left; dashboard = "https://storage.tail-test.ts.net" }
        )
        Install-JoinedAgent $stack "$($kept.ToUpper())\" "https://storage.tail-test.ts.net" | Should Be "installed"
        Get-AgentMode $global:desired | Should Be "joined"
        $global:desired.passThrough | Should Be "none"
        $global:desired.stackFolder | Should Be $stack
        @($global:desired.joinedNodes).Count | Should Be 1
        $global:desired.joinedNodes[0].dashboard | Should Be "https://storage.tail-test.ts.net"
    }

    It "the joined nodes survive a round trip through the installed config" {
        $desired = Get-DesiredAgentConfig $stack "" "none" $binary 0 @([pscustomobject]@{ root = $kept; dashboard = "https://storage.tail-test.ts.net" })
        Write-JsonFile (Join-Path $agentInstallFolder $agentConfigName) $desired
        (ConvertTo-ComparableJson (Get-InstalledAgentConfig)) | Should Be (ConvertTo-ComparableJson $desired)
    }
}

Describe "a join without an admin shell" {
    $stack = New-StackCopy
    $binary = Join-Path $scratch "syncthing-for-admin.exe"
    Set-Content -Path $binary -Value "binary"
    function Get-SyncthingBinary([string]$StackFolder) { return $binary }
    function Test-IsElevated { return $false }

    It "refuses to install the agent and says how" {
        $global:fakeService = $null
        { Install-JoinedAgent $stack (New-JoinedRoot "admin" -WithNodeFile) "https://storage.tail-test.ts.net" } | Should Throw "run the join once in an admin shell"
    }
}

Describe "down" {
    $stack = New-StackCopy
    $global:downCalls = @()
    function Test-IsElevated { return $true }
    function Stop-AgentService { $global:downCalls += "stop service" }
    function Invoke-ServiceControl([string[]]$Arguments) { $global:downCalls += "sc $($Arguments[0])" }
    function Stop-StackSyncthings([string]$StackFolder) { $global:downCalls += "stop syncthings" }
    function Remove-NetFirewallRule { [CmdletBinding()] param([string]$Group, [string]$Name) $global:downCalls += "remove rules" }
    function Remove-ProgramFirewallRules([string]$Folder) { $global:downCalls += "remove program rules" }
    function Get-JoinedAgentConfig([string]$Folder, [object[]]$JoinedNodes) { $global:downCalls += "joined config"; return [pscustomobject]@{ stackFolder = $Folder; joinedNodes = @($JoinedNodes) } }
    function Install-JoinedAgentService($Desired) {
        $global:downCalls += "install joined"
        $global:joinedInstall = $Desired
        if ($global:joinedInstallFails) { throw "no heartbeat within 120 s" }
        return "installed"
    }
    $global:joinedInstallFails = $false
    $kept = New-JoinedRoot "down-kept" -WithNodeFile
    $left = New-JoinedRoot "down-left"
    $global:fakeService = [pscustomobject]@{ State = "Running"; PathName = "agent"; ProcessId = 0 }

    It "removes the agent when no joined node is left" {
        $global:downCalls = @()
        Write-InstalledConfig "storage-compose" @([pscustomobject]@{ root = $left; dashboard = "https://storage.tail-test.ts.net" })
        Uninstall-HostAgent $stack | Should Be "removed"
        $global:downCalls -contains "install joined" | Should Be $false
        $global:downCalls -contains "remove rules" | Should Be $true
        Test-Path $agentInstallFolder | Should Be $false
    }

    It "removes what the stack added and hands the agent back to the joined nodes that are left" {
        $global:downCalls = @()
        Write-InstalledConfig "storage-compose" @(
            [pscustomobject]@{ root = $kept; dashboard = "https://storage.tail-test.ts.net" },
            [pscustomobject]@{ root = $left; dashboard = "https://storage.tail-test.ts.net" }
        )
        Uninstall-HostAgent $stack | Should Be "joined"
        $global:downCalls | Should Be @("joined config", "stop service", "sc delete", "stop syncthings", "remove rules", "remove program rules", "install joined")
        $global:joinedInstall.stackFolder | Should Be $stack
        @($global:joinedInstall.joinedNodes | ForEach-Object { $_.root }) | Should Be @($kept)
    }

    It "keeps a joined node whose volume is away" {
        $away = "$([char[]](68..90) | Where-Object { -not [System.IO.Directory]::Exists("$($_):\") } | Select-Object -Last 1):\"
        Write-InstalledConfig "storage-compose" @([pscustomobject]@{ root = $away; dashboard = "https://storage.tail-test.ts.net" })
        Uninstall-HostAgent $stack | Should Be "joined"
        @($global:joinedInstall.joinedNodes | ForEach-Object { $_.root }) | Should Be @($away)
    }

    It "names the joined roots and the command that restores them when the hand-back fails" {
        Write-InstalledConfig "storage-compose" @([pscustomobject]@{ root = $kept; dashboard = "https://storage.tail-test.ts.net" })
        $global:joinedInstallFails = $true
        try { $failure = try { Uninstall-HostAgent $stack; "" } catch { "$_" } } finally { $global:joinedInstallFails = $false }
        $failure | Should Match ([regex]::Escape("joined mode could not be installed for $kept"))
        $failure | Should Match ([regex]::Escape("& `"$(Join-Path $stack "join\storage-join.ps1")`" -Root `"$kept`" -Dashboard `"https://storage.tail-test.ts.net`""))
    }

    It "leaves a joined-mode agent alone" {
        $global:downCalls = @()
        Write-InstalledConfig "" @([pscustomobject]@{ root = $kept; dashboard = "https://storage.tail-test.ts.net" })
        Uninstall-HostAgent $stack | Should Be "joined"
        @($global:downCalls).Count | Should Be 0
    }
    $global:fakeService = $null
}

Describe "a removal still pending" {
    $global:pendingChecks = 0
    $global:installCalls = @()
    function Test-IsElevated { return $true }
    function Test-HostAgentIsCurrent($Desired) { return $false }
    function Test-AgentRemovalIsPending { $global:pendingChecks++; $global:installCalls += "pending?"; return $global:pendingChecks -le $global:pendingRounds }
    function Start-Sleep { }
    function Stop-AgentService { $global:installCalls += "stop service" }
    function Copy-AgentFiles($Desired) { $global:installCalls += "copy" }
    function Register-AgentService { $global:installCalls += "register" }
    function Start-Service { [CmdletBinding()] param([string]$Name) $global:installCalls += "start" }
    function Wait-ForAgentHeartbeat([string]$StackFolder) { return $true }
    $desired = [pscustomobject]@{ stackFolder = $scratch }

    It "is waited for before anything is copied" {
        $global:pendingChecks = 0
        $global:pendingRounds = 2
        $global:installCalls = @()
        Install-AgentService $desired "hint" | Should Be "installed"
        $global:installCalls | Should Be @("pending?", "pending?", "pending?", "stop service", "copy", "register", "start")
    }

    It "stops the install, with nothing copied, when it does not end" {
        $global:pendingChecks = 0
        $global:pendingRounds = 1000
        $global:installCalls = @()
        $agentRemovalWaitSeconds = 0
        { Install-AgentService $desired "hint" } | Should Throw "still removing itself"
        $global:installCalls -contains "copy" | Should Be $false
    }
}

Describe "the self-removal's delayed folder removal" {
    function Invoke-RemovalWithoutDelay([string]$ServiceName, [string]$Folder) {
        $agentServiceName = $ServiceName
        $agentInstallFolder = $Folder
        $command = (Get-AgentFolderRemovalCommand) -replace '^ping -n 20 127\.0\.0\.1 >nul & ', 'ping -n 1 127.0.0.1 >nul & '
        Start-Process -FilePath "cmd.exe" -ArgumentList "/c $command" -WindowStyle Hidden -Wait
    }

    It "waits, then removes the folder only while no service of the name is registered" {
        $command = Get-AgentFolderRemovalCommand
        $command | Should Match '^ping -n 20 127\.0\.0\.1 >nul & sc\.exe query '
        $command | Should Match ([regex]::Escape("|| rmdir /s /q `"$agentInstallFolder`""))
    }

    It "removes the folder when the service is gone" {
        $folder = Join-Path $scratch "removal-gone"
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
        Invoke-RemovalWithoutDelay "storage-compose-agent-test-never-installed" $folder
        Test-Path $folder | Should Be $false
    }

    It "keeps the folder when a service of the name is registered again" {
        $folder = Join-Path $scratch "removal-kept"
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
        Invoke-RemovalWithoutDelay "EventLog" $folder
        Test-Path $folder | Should Be $true
    }
}

Describe "replacing the old logon task" {
    $legacyAttachInstallFolder = Join-Path $scratch "legacy\storage-compose"
    $watcher = Join-Path $legacyAttachInstallFolder "watcher.ps1"
    $global:legacyTask = $null
    $global:legacyCalls = @()
    function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) if ($TaskName -eq $legacyAttachTaskName) { return $global:legacyTask } }
    function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName) $global:legacyCalls += "stop $TaskName" }
    function Unregister-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [switch]$Confirm) $global:legacyCalls += "unregister $TaskName" }

    It "does nothing when the task is not registered" {
        Remove-LegacyAttachTask | Should Be $false
        @($global:legacyCalls).Count | Should Be 0
    }

    It "stops and unregisters the task, ends its watcher and removes its folder" {
        New-Item -ItemType Directory -Force -Path $legacyAttachInstallFolder | Out-Null
        Set-Content -Path $watcher -Value "# the old watcher"
        $running = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -Command `"Start-Sleep -Seconds 120 # $watcher`"" -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 2
        $global:legacyTask = [pscustomobject]@{ TaskName = $legacyAttachTaskName }
        Remove-LegacyAttachTask | Should Be $true
        ($global:legacyCalls -join ",") | Should Be "stop $legacyAttachTaskName,unregister $legacyAttachTaskName"
        Start-Sleep -Seconds 1
        $running.HasExited | Should Be $true
        Test-Path $legacyAttachInstallFolder | Should Be $false
    }

    It "asks for an admin shell instead of leaving both running" {
        function Test-IsElevated { return $false }
        $global:legacyTask = [pscustomobject]@{ TaskName = $legacyAttachTaskName }
        { Remove-LegacyAttachTask } | Should Throw "admin shell"
    }
}

Describe "up" {
    $cli = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repository "docker-compose.ps1"), [ref]$null, [ref]$null)
    function Get-CallOrder([string]$Function) {
        $definition = $cli.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Function }, $true)
        return @($definition.Body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ })
    }

    It "replaces the old task before it installs the agent" {
        $calls = Get-CallOrder "Install-Agent"
        [array]::IndexOf($calls, "Remove-LegacyAttachTask") | Should BeLessThan ([array]::IndexOf($calls, "Install-HostAgent"))
        [array]::IndexOf($calls, "Remove-LegacyAttachTask") | Should Not Be -1
    }

    It "installs the agent before it passes any drive through" {
        $calls = Get-CallOrder "Start-Array"
        [array]::IndexOf($calls, "Install-Agent") | Should BeLessThan ([array]::IndexOf($calls, "Connect-Drives"))
        [array]::IndexOf($calls, "Install-Agent") | Should Not Be -1
    }

    It "removes the agent on down, after the drives are released" {
        $calls = Get-CallOrder "Stop-Array"
        [array]::IndexOf($calls, "Disconnect-Drives") | Should BeLessThan ([array]::IndexOf($calls, "Remove-Agent"))
    }
}

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
