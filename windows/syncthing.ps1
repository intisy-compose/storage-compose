# One native Syncthing per drive or folder node, its home on the node (`.storage\syncthing`), so the
# node keeps its device ID on whichever host it is attached to. Dot-sourced by the agent; defines
# functions only. The agent sets $script:syncthingPath, $script:syncthingSha256 and $script:agentState.

$syncthingStopSeconds = 15
$syncthingAttemptWindowSeconds = 600
$syncthingAttemptsPerWindow = 3
$syncthingStableRunSeconds = 60
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

function Set-XmlChildList($Parent, [string]$Name, [string[]]$Values) {
    $existing = @($Parent.SelectNodes($Name))
    $current = @($existing | ForEach-Object { $_.InnerText })
    if ($current.Count -eq @($Values).Count -and ($current -join "`n") -ceq (@($Values) -join "`n")) { return $false }
    foreach ($element in $existing) { [void]$Parent.RemoveChild($element) }
    foreach ($value in $Values) {
        $element = $Parent.OwnerDocument.CreateElement($Name)
        $element.InnerText = $value
        [void]$Parent.AppendChild($element)
    }
    return $true
}

function Set-ListenAddresses($Options, [string[]]$Addresses) { return Set-XmlChildList $Options "listenAddress" $Addresses }

$profileListenAddressPattern = '^(tcp|quic|relay|dynamic\+https?)://'

function Test-IsProfileListenAddress($Address) { return $Address -is [string] -and $Address -match $profileListenAddressPattern }

function Test-IsConnectionsEntry($Entry) {
    if ($Entry -isnot [System.Management.Automation.PSCustomObject] -or -not $Entry.PSObject.Properties["listenAddresses"]) { return $false }
    $addresses = @($Entry.listenAddresses)
    return $addresses.Count -gt 0 -and @($addresses | Where-Object { -not (Test-IsProfileListenAddress $_) }).Count -eq 0
}

<#
.NOTES
The node's entry of the connections file the dashboard writes through a read-write bind (the agent
never writes it). Null without the file, without an entry for the node, or with an entry that is not
an object whose listen addresses are all Syncthing address strings: a malformed value written into
config.xml can keep Syncthing from loading it, so such a node stays tailnet-only instead.
#>
function Get-NodeConnections($Node) {
    if (-not $script:connectionsFile) { return $null }
    $byNode = Read-JsonFile $script:connectionsFile
    if (-not $byNode -or -not $byNode.PSObject.Properties[$Node.id]) { return $null }
    $entry = $byNode.($Node.id)
    if (-not (Test-IsConnectionsEntry $entry)) { return $null }
    return $entry
}

function Get-NodeListenAddresses($Connections, [string]$ListenHost, $Ports) {
    if ($Connections) { return @($Connections.listenAddresses) }
    return @("tcp://$ListenHost`:$($Ports.listen)")
}

$profileSwitchNames = @("globalAnnounceEnabled", "localAnnounceEnabled", "relaysEnabled", "natEnabled", "limitBandwidthInLan")
$profileRateNames = @("maxSendKbps", "maxRecvKbps")
$tailnetOnlyOptions = [ordered]@{
    globalAnnounceEnabled = "false"; localAnnounceEnabled = "false"; relaysEnabled = "false"; natEnabled = "false"
    maxSendKbps = "0"; maxRecvKbps = "0"; limitBandwidthInLan = "false"
}

function Test-IsRate($Value) { return ($Value -is [int] -or $Value -is [long]) -and $Value -ge 0 }
$keptOptions = [ordered]@{ urAccepted = "-1"; autoUpgradeIntervalH = "0"; crashReportingEnabled = "false"; startBrowser = "false" }

function Get-ProfileOptionValues($Connections) {
    $values = [ordered]@{}
    if (-not $Connections.PSObject.Properties["options"] -or -not $Connections.options) { return $values }
    $options = $Connections.options
    foreach ($name in $profileSwitchNames) {
        if ($options.PSObject.Properties[$name] -and $options.$name -is [bool]) { $values[$name] = $(if ($options.$name) { "true" } else { "false" }) }
    }
    foreach ($name in $profileRateNames) {
        if ($options.PSObject.Properties[$name] -and (Test-IsRate $options.$name)) { $values[$name] = "$($options.$name)" }
    }
    return $values
}

function Set-ProfileAnnounceServers($Options, $Connections) {
    if (-not $Connections.PSObject.Properties["options"] -or -not $Connections.options -or -not $Connections.options.PSObject.Properties["globalAnnounceServers"]) { return $false }
    $servers = @($Connections.options.globalAnnounceServers)
    if (@($servers | Where-Object { $_ -isnot [string] }).Count -gt 0) { return $false }
    return Set-XmlChildList $Options "globalAnnounceServer" $servers
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
With the node's entry of the connections file, its discovery, relay, NAT, limit and listen settings
are the cluster profile's, applied before Syncthing starts so it never listens with stale ones;
without it they are tailnet-only (discovery, relays and NAT off, listening on the tailnet address),
which is also what a device joined without the host agent runs. Usage reporting is declined once so
Syncthing never asks, in both cases. The host check is off because the dashboard's container calls as
host.docker.internal, which Syncthing otherwise answers with 403; the GUI listens on loopback only
and every call needs the API key.
#>
function Set-SyncthingConfig($Node, $Ports, [string]$ListenHost, $Connections) {
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
    $changed = (Set-ListenAddresses $options @(Get-NodeListenAddresses $Connections $ListenHost $Ports)) -or $changed
    $settings = $(if ($Connections) { Get-ProfileOptionValues $Connections } else { $tailnetOnlyOptions })
    if ($Connections) { $changed = (Set-ProfileAnnounceServers $options $Connections) -or $changed }
    foreach ($values in @($settings, $keptOptions)) {
        foreach ($name in @($values.Keys)) { $changed = (Set-XmlChildText $options $name $values[$name]) -or $changed }
    }
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

function Get-FirewallUdpRuleName($Node) { return "$(Get-FirewallRuleName $Node) udp" }

function Test-FirewallRuleIsCurrent([string]$Name, [string]$Port) {
    $existing = Get-NetFirewallRule -Name $Name -ErrorAction SilentlyContinue
    if (-not $existing) { return $false }
    $filter = $existing | Get-NetFirewallPortFilter
    $program = ($existing | Get-NetFirewallApplicationFilter).Program
    if ("$($filter.LocalPort)" -eq $Port -and $program -eq $script:syncthingPath) { return $true }
    Remove-NetFirewallRule -Name $Name
    return $false
}

<#
.NOTES
Both rules exist before Syncthing first listens. Windows asks "allow access?" for a program no rule
names, and its answer is a rule open to every address that outlives the stack; with a TCP rule for the
tailnet and a UDP block (no QUIC, no discovery) for this program, it never asks.
#>
function Set-SyncthingFirewallRule($Node, $Ports) {
    $name = Get-FirewallRuleName $Node
    if (-not (Test-FirewallRuleIsCurrent $name "$($Ports.listen)")) {
        New-NetFirewallRule -Name $name -DisplayName "$name ($($Node.name))" -Group $agentFirewallGroup -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $Ports.listen -RemoteAddress $tailnetAddressRange -Program $script:syncthingPath -Profile Any | Out-Null
    }
    $udpName = Get-FirewallUdpRuleName $Node
    if (-not (Test-FirewallRuleIsCurrent $udpName "Any")) {
        New-NetFirewallRule -Name $udpName -DisplayName "$udpName ($($Node.name))" -Group $agentFirewallGroup -Direction Inbound -Action Block `
            -Protocol UDP -Program $script:syncthingPath -Profile Any | Out-Null
    }
}

function Remove-NodeFirewallRules($Node) {
    foreach ($name in @((Get-FirewallRuleName $Node), (Get-FirewallUdpRuleName $Node))) { Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue }
}

function Get-SyncthingBinFolder {
    if (-not $script:syncthingPath) { return $null }
    return Split-Path (Split-Path $script:syncthingPath)
}

function Remove-SyncthingFirewallRules {
    Remove-NetFirewallRule -Group $agentFirewallGroup -ErrorAction SilentlyContinue
    Remove-ProgramFirewallRules (Get-SyncthingBinFolder)
}

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
        nodeId = $Node.id; node = $Node; ports = $null; apiKey = $null; deviceId = $null; listenAddress = $null; usesProfile = $false
        processId = 0; state = "stopped"; startedAt = $null; attempts = @(); problem = $null
    }
}

function Test-InstanceIsBackingOff($Instance) {
    $since = (Get-Date).AddSeconds(-$syncthingAttemptWindowSeconds)
    $Instance.attempts = @($Instance.attempts | Where-Object { $_ -gt $since })
    return $Instance.attempts.Count -ge $syncthingAttemptsPerWindow
}

<#
.NOTES
A Syncthing that ran at least $syncthingStableRunSeconds before it exited was restarted on request,
such as the dashboard's Restart, not crashing; only quick exits count toward the backoff.
#>
function Test-InstanceRanStably($Instance) {
    if (-not $Instance.startedAt) { return $false }
    $started = [datetime]::Parse($Instance.startedAt, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
    return ((Get-Date) - $started).TotalSeconds -ge $syncthingStableRunSeconds
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
        $connections = Get-NodeConnections $node
        $identity = Set-SyncthingConfig $node $Instance.ports $ListenHost $connections
        $Instance.apiKey = $identity.apiKey
        $Instance.deviceId = $identity.deviceId
        $Instance.listenAddress = @(Get-NodeListenAddresses $connections $ListenHost $Instance.ports)[0]
        $Instance.usesProfile = [bool]$connections
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
    Remove-NodeFirewallRules $Instance.node
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
    $Instance.usesProfile = [bool](Get-NodeConnections $Instance.node)
    $Instance.deviceId = Get-SyncthingDeviceId $Instance.node
    Write-WatcherLog "node $($Instance.node.name) ($($Instance.nodeId)): took over the running Syncthing, pid $($Instance.processId)"
    return $true
}

<#
.NOTES
Only a tailnet-only node listens on the tailnet address itself; one under the connection profile
listens on 0.0.0.0 and keeps listening when that address changes.
#>
function Test-NeedsRestartForAddress($Instance, [string]$ListenHost) {
    if ($Instance.usesProfile) { return $false }
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
    $stoppedAny = $false
    foreach ($id in @($script:syncthingInstances.Keys)) {
        if ($wanted.ContainsKey($id) -and $wanted[$id].root -eq $script:syncthingInstances[$id].node.root) { continue }
        $instance = $script:syncthingInstances[$id]
        if ($instance.state -eq "running") { Stop-NodeSyncthing $instance $(if ($IsActive) { "its node is gone" } else { "the stack is not running" }) }
        $script:syncthingInstances.Remove($id)
        $stoppedAny = $true
    }
    if ($wanted.Count -eq 0) {
        if ($stoppedAny) { Remove-SyncthingFirewallRules }
        return $binaryProblem
    }
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
            if (Test-InstanceRanStably $instance) { $instance.attempts = @() }
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
    Remove-SyncthingFirewallRules
}

<#
.NOTES
A node's root can be a folder, so the volume is the root's drive; null when it cannot be read (a
drive pulled mid-round must not fail the heartbeat).
#>
function Get-NodeSpace([string]$Root) {
    try {
        $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Root))
        if (-not $drive.IsReady) { return $null }
        return [ordered]@{ size = [int64]$drive.TotalSize; free = [int64]$drive.AvailableFreeSpace }
    } catch {
        return $null
    }
}

function Get-PublishedInstance($Instance) {
    $published = [ordered]@{
        id = $Instance.node.id; name = $Instance.node.name; kind = $Instance.node.kind; threshold = $Instance.node.threshold
        assigned = @($Instance.node.assigned); root = $Instance.node.root; space = Get-NodeSpace $Instance.node.root
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
