# One native Syncthing per drive or folder node, its home on the node (`.storage\syncthing`), so the
# node keeps its device ID on whichever host it is attached to. Dot-sourced by the agent; defines
# functions only. The agent sets $script:syncthingPath, $script:syncthingSha256 and $script:agentState.

$syncthingStopSeconds = 15
$syncthingAttemptWindowSeconds = 600
$syncthingAttemptsPerWindow = 3
$syncthingLogMaxBytes = 10485760
$tailscaleCli = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
$syncthingInstances = @{}

<#
.NOTES
Path.Combine, not Join-Path: Join-Path fails once the node's drive letter is gone, which is exactly
when the agent must still stop its Syncthing.
#>
function Get-SyncthingHome($Node) { return [System.IO.Path]::Combine($Node.root, ".storage\syncthing") }

function Get-SyncthingConfigPath($Node) { return [System.IO.Path]::Combine((Get-SyncthingHome $Node), "config.xml") }

<#
.NOTES
Syncthing listens on the tailnet only (the port table's kind `protocol`); without a tailnet address it
listens on loopback, which keeps it from the LAN at the price of no peers until Tailscale is up.
#>
function Get-TailnetAddress {
    if (-not (Test-Path $tailscaleCli)) { return $null }
    $result = Invoke-NativeCommand $tailscaleCli @("ip", "-4")
    if ($result.ExitCode -ne 0) { return $null }
    $address = $result.Output -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^100\.\d+\.\d+\.\d+$' } | Select-Object -First 1
    return $address
}

function Get-NodePorts($Node) {
    $ports = $script:agentState.ports
    if ($ports.PSObject.Properties[$Node.id]) { return $ports.($Node.id) }
    $taken = @($ports.PSObject.Properties | ForEach-Object { [int]$_.Value.slot })
    $slot = 0..($syncthingPortCount - 1) | Where-Object { $_ -notin $taken } | Select-Object -First 1
    if ($null -eq $slot) { throw "all $syncthingPortCount Syncthing port slots are taken" }
    $assigned = [pscustomobject]@{ slot = $slot; gui = $syncthingGuiPortBase + $slot; listen = $syncthingListenPortBase + $slot }
    $ports | Add-Member -NotePropertyName $Node.id -NotePropertyValue $assigned
    $script:agentStateChanged = $true
    return $assigned
}

function Test-SyncthingBinary {
    if (-not ($script:syncthingPath -and (Test-Path -LiteralPath $script:syncthingPath))) { return "Syncthing is missing at $script:syncthingPath; run up again" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $script:syncthingPath).Hash.ToLower()
    if ($hash -ne "$script:syncthingSha256".ToLower()) { return "$script:syncthingPath does not match the checksum recorded at install; run up again" }
    return $null
}

function New-SyncthingConfig($Node) {
    $result = Invoke-NativeCommand $script:syncthingPath @("generate", "--home=$(Get-SyncthingHome $Node)", "--no-port-probing")
    if ($result.ExitCode -ne 0) { throw "syncthing generate failed: $($result.Output)" }
}

function Set-XmlChildText($Parent, [string]$Name, [string]$Value) {
    $child = $Parent.SelectSingleNode($Name)
    if (-not $child) { $child = $Parent.AppendChild($Parent.OwnerDocument.CreateElement($Name)) }
    if ($child.InnerText -eq $Value) { return $false }
    $child.InnerText = $Value
    return $true
}

function Set-ListenAddress($Options, [string]$Address) {
    $current = @($Options.SelectNodes("listenAddress") | ForEach-Object { $_.InnerText })
    if ($current.Count -eq 1 -and $current[0] -eq $Address) { return $false }
    foreach ($element in @($Options.SelectNodes("listenAddress"))) { [void]$Options.RemoveChild($element) }
    $element = $Options.OwnerDocument.CreateElement("listenAddress")
    $element.InnerText = $Address
    [void]$Options.PrependChild($element)
    return $true
}

function Save-XmlDocument($Document, [string]$Path) {
    $settings = New-Object System.Xml.XmlWriterSettings
    $settings.Indent = $true
    $settings.Encoding = New-Object System.Text.UTF8Encoding $false
    $partial = "$Path.partial"
    $writer = [System.Xml.XmlWriter]::Create($partial, $settings)
    try { $Document.Save($writer) } finally { $writer.Close() }
    [System.IO.File]::Copy($partial, $Path, $true)
    Remove-Item -LiteralPath $partial -Force
}

<#
.NOTES
Discovery, relays and NAT traversal are off because peers reach a node only over the tailnet, by the
address the dashboard hands out; usage reporting is declined once so Syncthing never asks. The host
check is off because the dashboard's container calls as host.docker.internal, which Syncthing
otherwise answers with 403; the GUI listens on loopback only and every call needs the API key.
#>
function Set-SyncthingConfig($Node, $Ports, [string]$ListenHost) {
    $path = Get-SyncthingConfigPath $Node
    $document = New-Object System.Xml.XmlDocument
    $document.PreserveWhitespace = $false
    $document.Load($path)
    $configuration = $document.DocumentElement
    $changed = $false
    $gui = $configuration.SelectSingleNode("gui")
    $changed = (Set-XmlChildText $gui "address" "127.0.0.1:$($Ports.gui)") -or $changed
    if ($gui.GetAttribute("tls") -ne "false") { $gui.SetAttribute("tls", "false"); $changed = $true }
    if (-not $gui.SelectSingleNode("apikey").InnerText) { $changed = (Set-XmlChildText $gui "apikey" (New-ApiKey)) -or $changed }
    $changed = (Set-XmlChildText $gui "insecureSkipHostcheck" "true") -or $changed
    $options = $configuration.SelectSingleNode("options")
    $changed = (Set-ListenAddress $options "tcp://$ListenHost`:$($Ports.listen)") -or $changed
    $settings = [ordered]@{
        globalAnnounceEnabled = "false"; localAnnounceEnabled = "false"; relaysEnabled = "false"; natEnabled = "false"
        urAccepted = "-1"; autoUpgradeIntervalH = "0"; crashReportingEnabled = "false"; startBrowser = "false"
    }
    foreach ($name in $settings.Keys) { $changed = (Set-XmlChildText $options $name $settings[$name]) -or $changed }
    $self = Get-SelfDeviceElement $configuration $Node
    if ($self -and $self.GetAttribute("name") -ne $Node.name) { $self.SetAttribute("name", $Node.name); $changed = $true }
    if ($changed) { Save-XmlDocument $document $path }
    return [pscustomobject]@{ apiKey = $gui.SelectSingleNode("apikey").InnerText; deviceId = $(if ($self) { $self.GetAttribute("id") } else { $null }) }
}

function Get-SelfDeviceElement($Configuration, $Node) {
    $deviceId = Get-SyncthingDeviceId $Node
    if (-not $deviceId) { return $null }
    return $Configuration.SelectNodes("device") | Where-Object { $_.GetAttribute("id") -eq $deviceId } | Select-Object -First 1
}

function Get-SyncthingDeviceId($Node) {
    $result = Invoke-NativeCommand $script:syncthingPath @("device-id", "--home=$(Get-SyncthingHome $Node)")
    if ($result.ExitCode -ne 0) { return $null }
    return $result.Output -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$' } | Select-Object -First 1
}

function New-ApiKey {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).Replace("+", "a").Replace("/", "b").TrimEnd("=")
}

function Get-FirewallRuleName($Node) { return "storage-compose syncthing $($Node.id)" }

function Set-SyncthingFirewallRule($Node, $Ports) {
    $name = Get-FirewallRuleName $Node
    $existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if ($existing) {
        $filter = $existing | Get-NetFirewallPortFilter
        $program = ($existing | Get-NetFirewallApplicationFilter).Program
        if ("$($filter.LocalPort)" -eq "$($Ports.listen)" -and $program -eq $script:syncthingPath) { return }
        Remove-NetFirewallRule -Name $name
    }
    New-NetFirewallRule -Name $name -DisplayName "$name ($($Node.name))" -Group $agentFirewallGroup -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Ports.listen -RemoteAddress $tailnetAddressRange -Program $script:syncthingPath -Profile Any | Out-Null
}

function Remove-SyncthingFirewallRules { Remove-NetFirewallRule -Group $agentFirewallGroup -ErrorAction SilentlyContinue }

function Get-SyncthingProcesses {
    if (-not $script:syncthingPath) { return @() }
    return @(Get-CimInstance Win32_Process -Filter "Name='syncthing.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $script:syncthingPath })
}

function Get-NodeSyncthingProcesses($Node) {
    $homeArgument = "--home=$(Get-SyncthingHome $Node)"
    return @(Get-SyncthingProcesses | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($homeArgument) })
}

<#
.NOTES
Syncthing on Windows starts itself again as a child process, so a node's Syncthing is a parent and a
child with the same command line; the agent tracks the parent and stops both.
#>
function Find-SyncthingProcess($Node) {
    $processes = Get-NodeSyncthingProcesses $Node
    $ids = @($processes | ForEach-Object { [int]$_.ProcessId })
    return $processes | Where-Object { [int]$_.ParentProcessId -notin $ids } | Select-Object -First 1
}

<#
.NOTES
Waits for the exit, because Stop-Process returns before the database lock and the ports are free and
a Syncthing started on them at once fails.
#>
function Stop-NodeSyncthingProcesses($Node) {
    $processes = @(Get-NodeSyncthingProcesses $Node)
    foreach ($process in $processes) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($process in $processes) { Wait-Process -Id $process.ProcessId -Timeout $syncthingStopSeconds -ErrorAction SilentlyContinue }
}

function Start-SyncthingProcess($Node) {
    $syncthingHome = Get-SyncthingHome $Node
    $arguments = @("serve", "--home=$syncthingHome", "--no-browser", "--no-restart", "--no-upgrade",
        "--log-file=$([System.IO.Path]::Combine($syncthingHome, 'syncthing.log'))", "--log-max-size=$syncthingLogMaxBytes", "--log-max-old-files=2")
    $start = New-Object System.Diagnostics.ProcessStartInfo $script:syncthingPath, (Join-CommandLine $arguments)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WorkingDirectory = $syncthingHome
    return [System.Diagnostics.Process]::Start($start).Id
}

function Join-CommandLine([string[]]$Arguments) {
    return (@($Arguments | ForEach-Object {
        if ($_ -notmatch '[\s"]') { $_ } else { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
    }) -join " ")
}

function Test-ProcessIsRunning([int]$ProcessId) { return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) }

function Invoke-SyncthingApi($Instance, [string]$Method, [string]$Path) {
    $uri = "http://127.0.0.1:$($Instance.ports.gui)$Path"
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers @{ "X-API-Key" = $Instance.apiKey } -TimeoutSec 5 -UseBasicParsing
}

function Stop-SyncthingProcess($Instance) {
    $volumeIsThere = [System.IO.Directory]::Exists($Instance.node.root)
    if ($volumeIsThere -and (Test-ProcessIsRunning $Instance.processId)) {
        try { Invoke-SyncthingApi $Instance "Post" "/rest/system/shutdown" | Out-Null } catch { }
        $deadline = (Get-Date).AddSeconds($syncthingStopSeconds)
        while (@(Get-NodeSyncthingProcesses $Instance.node).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    }
    Stop-NodeSyncthingProcesses $Instance.node
}

function New-SyncthingInstance($Node) {
    return [pscustomobject]@{
        nodeId = $Node.id; node = $Node; ports = $null; apiKey = $null; deviceId = $null; listenAddress = $null
        processId = 0; state = "stopped"; startedAt = $null; attempts = @(); problem = $null
    }
}

function Test-InstanceIsBackingOff($Instance) {
    $since = (Get-Date).AddSeconds(-$syncthingAttemptWindowSeconds)
    $Instance.attempts = @($Instance.attempts | Where-Object { $_ -gt $since })
    return $Instance.attempts.Count -ge $syncthingAttemptsPerWindow
}

function Start-NodeSyncthing($Instance, [string]$ListenHost) {
    $node = $Instance.node
    if (Test-InstanceIsBackingOff $Instance) { $Instance.state = "failed"; return }
    $Instance.attempts = @($Instance.attempts) + (Get-Date)
    try {
        Stop-NodeSyncthingProcesses $node
        $Instance.ports = Get-NodePorts $node
        New-Item -ItemType Directory -Force -Path (Get-SyncthingHome $node) | Out-Null
        if (-not (Test-Path -LiteralPath (Get-SyncthingConfigPath $node))) { New-SyncthingConfig $node }
        $identity = Set-SyncthingConfig $node $Instance.ports $ListenHost
        $Instance.apiKey = $identity.apiKey
        $Instance.deviceId = $identity.deviceId
        $Instance.listenAddress = "tcp://$ListenHost`:$($Instance.ports.listen)"
        Set-SyncthingFirewallRule $node $Instance.ports
        $Instance.processId = Start-SyncthingProcess $node
        $Instance.state = "running"
        $Instance.startedAt = (Get-Date).ToString("o")
        $Instance.problem = $null
        Write-WatcherLog "node $($node.name) ($($node.id)): Syncthing started at $($node.root), GUI 127.0.0.1:$($Instance.ports.gui)"
    } catch {
        $Instance.state = "failed"
        $Instance.problem = "Syncthing did not start: $_"
        Write-WatcherLog "node $($node.name) ($($node.id)): $($Instance.problem)"
    }
}

function Stop-NodeSyncthing($Instance, [string]$Reason) {
    Stop-SyncthingProcess $Instance
    Remove-NetFirewallRule -Name (Get-FirewallRuleName $Instance.node) -ErrorAction SilentlyContinue
    $Instance.state = "stopped"
    $Instance.processId = 0
    Write-WatcherLog "node $($Instance.node.name) ($($Instance.nodeId)): Syncthing stopped, $Reason"
}

<#
.NOTES
A Syncthing left running by an agent that crashed is taken over rather than started twice, which
would fail on the database lock.
#>
function Resume-OrphanedSyncthing($Instance) {
    $orphan = Find-SyncthingProcess $Instance.node
    if (-not $orphan) { return $false }
    $Instance.ports = Get-NodePorts $Instance.node
    $Instance.processId = [int]$orphan.ProcessId
    $Instance.state = "running"
    $Instance.startedAt = (Get-Date).ToString("o")
    try {
        $document = [xml][System.IO.File]::ReadAllText((Get-SyncthingConfigPath $Instance.node))
        $Instance.apiKey = $document.configuration.gui.apikey
        $Instance.listenAddress = $document.configuration.options.listenAddress | Select-Object -First 1
    } catch { }
    $Instance.deviceId = Get-SyncthingDeviceId $Instance.node
    Write-WatcherLog "node $($Instance.node.name) ($($Instance.nodeId)): took over the running Syncthing, pid $($Instance.processId)"
    return $true
}

function Test-NeedsRestartForAddress($Instance, [string]$ListenHost) {
    return $Instance.state -eq "running" -and $Instance.ports -and $Instance.listenAddress -ne "tcp://$ListenHost`:$($Instance.ports.listen)"
}

<#
.NOTES
Called every round. While the stack is down, or the binary fails its checksum, every instance is
stopped; otherwise every found node gets exactly one running Syncthing and a vanished node's is
stopped. A node whose volume vanished cannot be shut down cleanly through the API (its database
is gone with it), so the process is ended.
#>
function Update-NodeInstances([object[]]$Nodes, [bool]$IsActive) {
    $binaryProblem = $null
    if ($IsActive -and @($Nodes).Count -gt 0) { $binaryProblem = Test-SyncthingBinary }
    $wanted = @{}
    if ($IsActive -and -not $binaryProblem) { foreach ($node in $Nodes) { $wanted[$node.id] = $node } }
    foreach ($id in @($script:syncthingInstances.Keys)) {
        if ($wanted.ContainsKey($id) -and $wanted[$id].root -eq $script:syncthingInstances[$id].node.root) { continue }
        $instance = $script:syncthingInstances[$id]
        if ($instance.state -eq "running") { Stop-NodeSyncthing $instance $(if ($IsActive) { "its node is gone" } else { "the stack is not running" }) }
        $script:syncthingInstances.Remove($id)
    }
    if ($wanted.Count -eq 0) { return $binaryProblem }
    $listenHost = Get-TailnetAddress
    if (-not $listenHost) { $listenHost = "127.0.0.1" }
    foreach ($node in $wanted.Values) {
        if (-not $script:syncthingInstances.ContainsKey($node.id)) {
            $instance = New-SyncthingInstance $node
            $script:syncthingInstances[$node.id] = $instance
            if (Resume-OrphanedSyncthing $instance) { continue }
        }
        $instance = $script:syncthingInstances[$node.id]
        $instance.node = $node
        if (Test-NeedsRestartForAddress $instance $listenHost) { Stop-NodeSyncthing $instance "its tailnet address changed" }
        if ($instance.state -eq "running" -and -not (Test-ProcessIsRunning $instance.processId)) {
            Write-WatcherLog "node $($node.name) ($($node.id)): Syncthing exited; starting it again"
            $instance.state = "stopped"
        }
        if ($instance.state -ne "running") { Start-NodeSyncthing $instance $listenHost }
    }
    return $binaryProblem
}

function Stop-AllNodeInstances([string]$Reason) {
    foreach ($id in @($script:syncthingInstances.Keys)) {
        $instance = $script:syncthingInstances[$id]
        if ($instance.state -eq "running") { Stop-NodeSyncthing $instance $Reason }
        $script:syncthingInstances.Remove($id)
    }
    foreach ($orphan in Get-SyncthingProcesses) { Stop-Process -Id $orphan.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Get-PublishedInstance($Instance) {
    $published = [ordered]@{
        id = $Instance.node.id; name = $Instance.node.name; kind = $Instance.node.kind; threshold = $Instance.node.threshold
        assigned = @($Instance.node.assigned); root = $Instance.node.root
        syncthing = [ordered]@{
            state = $Instance.state; processId = $Instance.processId; deviceId = $Instance.deviceId; startedAt = $Instance.startedAt
            guiPort = $null; listenPort = $null; listenAddress = $Instance.listenAddress; apiKey = $Instance.apiKey
            home = Get-SyncthingHome $Instance.node; problem = $Instance.problem
        }
    }
    if ($Instance.ports) {
        $published.syncthing.guiPort = $Instance.ports.gui
        $published.syncthing.listenPort = $Instance.ports.listen
    }
    return [pscustomobject]$published
}
