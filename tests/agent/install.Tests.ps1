# Pester 3.4: fetching Syncthing, building the service host and deciding whether the installed agent
# is current, against a temporary install folder and a fake download and service manager. Nothing
# here registers a service or touches Program Files.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\disks.ps1")
. (Join-Path $repository "windows\agent-files.ps1")
. (Join-Path $repository "windows\agent-install.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-install-$([guid]::NewGuid())"
$agentInstallFolder = Join-Path $scratch "Program Files\storage-compose-agent"
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

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
