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

$profileListenAddressPattern = '^((tcp|quic)[46]?|relay|dynamic\+https?)://'

function Test-IsProfileListenAddress($Address) { return $Address -is [string] -and $Address -cmatch $profileListenAddressPattern }

function Test-IsProfileListenList($Addresses) {
    $list = @($Addresses)
    return $list.Count -gt 0 -and @($list | Where-Object { -not (Test-IsProfileListenAddress $_) }).Count -eq 0
}

function Test-IsConnectionsEntry($Entry) { return $Entry -is [System.Management.Automation.PSCustomObject] }

function Test-HasProfileListenAddresses($Entry) {
    return (Test-IsConnectionsEntry $Entry) -and $Entry.PSObject.Properties["listenAddresses"] -and $Entry.listenAddresses -is [array] -and
        (Test-IsProfileListenList $Entry.listenAddresses)
}

$unreadableConnections = [pscustomobject]@{ unreadable = $true }

function Test-IsUnreadableConnections($Connections) { return [object]::ReferenceEquals($Connections, $unreadableConnections) }

function Read-ConnectionsFile([string]$Path) {
    try { $byNode = Get-Content -Raw -LiteralPath $Path -ErrorAction Stop | ConvertFrom-Json } catch { return $unreadableConnections }
    if ($byNode -isnot [System.Management.Automation.PSCustomObject]) { return $unreadableConnections }
    return $byNode
}

<#
.NOTES
The node's entry of the connections file the dashboard writes through a read-write bind (the agent
never writes it). Null without the file, without an entry for the node, or with an entry that is not
an object, so such a node stays tailnet-only. An entry's values are checked where they are written,
because a malformed value written into config.xml can keep Syncthing from loading it. A file that
exists but cannot be read or parsed (caught mid-write, say) is $unreadableConnections, never null, so
the callers keep the node's current rules and settings instead of swapping it to tailnet-only.
#>
function Get-NodeConnections($Node) {
    if (-not $script:connectionsFile -or -not (Test-Path -LiteralPath $script:connectionsFile)) { return $null }
    $byNode = Read-ConnectionsFile $script:connectionsFile
    if (Test-IsUnreadableConnections $byNode) { return $byNode }
    if (-not $byNode.PSObject.Properties[$Node.id]) { return $null }
    $entry = $byNode.($Node.id)
    if (-not (Test-IsConnectionsEntry $entry)) { return $null }
    return $entry
}

function Test-IsTailnetOnlyListen($Addresses) {
    return @($Addresses).Count -eq 1 -and "$(@($Addresses)[0])" -match '^tcp://(?!0\.0\.0\.0:)'
}

<#
.NOTES
The entry a node's config.xml already runs with: its listen addresses and whether local announce is
on, which is all the start and the firewall read from an entry. Null for a tailnet-only config.
#>
function Get-ConfiguredConnections($Node) {
    try { $options = ([xml][System.IO.File]::ReadAllText((Get-SyncthingConfigPath $Node))).configuration.options } catch { return $null }
    $addresses = @($options.SelectNodes("listenAddress") | ForEach-Object { $_.InnerText })
    $entry = [pscustomobject]@{ options = [pscustomobject]@{ localAnnounceEnabled = "$($options.localAnnounceEnabled)" -eq "true" }; listenAddresses = $addresses }
    if ((Test-IsTailnetOnlyListen $addresses) -or -not (Test-HasProfileListenAddresses $entry)) { return $null }
    return $entry
}

function Get-StartConnections($Node) {
    $connections = Get-NodeConnections $Node
    if (Test-IsUnreadableConnections $connections) { return Get-ConfiguredConnections $Node }
    return $connections
}

function Test-IsKeptProfileListen($Addresses) { return (Test-IsProfileListenList $Addresses) -and -not (Test-IsTailnetOnlyListen $Addresses) }

<#
.NOTES
The one rule of every keeper: a listen list with any invalid address is ignored whole while the
entry's valid options still apply, so the node keeps the profile addresses its config already has,
or the tailnet address when it has none (a fresh config's `default` would take the cluster's 22000).
#>
function Get-NodeListen($Connections, [string[]]$Configured, [string]$ListenHost, $Ports) {
    if (Test-HasProfileListenAddresses $Connections) { return [pscustomobject]@{ addresses = @($Connections.listenAddresses); isTailnetOnly = $false } }
    if ($Connections -and (Test-IsKeptProfileListen $Configured)) { return [pscustomobject]@{ addresses = @($Configured); isTailnetOnly = $false } }
    return [pscustomobject]@{ addresses = @("tcp://$ListenHost`:$($Ports.listen)"); isTailnetOnly = $true }
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
    $configured = @($options.SelectNodes("listenAddress") | ForEach-Object { $_.InnerText })
    $listen = Get-NodeListen $Connections $configured $ListenHost $Ports
    $changed = (Set-ListenAddresses $options $listen.addresses) -or $changed
    $settings = $(if ($Connections) { Get-ProfileOptionValues $Connections } else { $tailnetOnlyOptions })
    if ($Connections) { $changed = (Set-ProfileAnnounceServers $options $Connections) -or $changed }
    foreach ($values in @($settings, $keptOptions)) {
        foreach ($name in @($values.Keys)) { $changed = (Set-XmlChildText $options $name $values[$name]) -or $changed }
    }
    $self = Get-SelfDeviceElement $configuration $Node
    if ($self -and $self.GetAttribute("name") -ne $Node.name) { $self.SetAttribute("name", $Node.name); $changed = $true }
    if ($changed) { Save-XmlDocument $document $path }
    return [pscustomobject]@{ apiKey = $gui.SelectSingleNode("apikey").InnerText; deviceId = $(if ($self) { $self.GetAttribute("id") } else { $null }); listen = $listen }
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

$localDiscoveryPort = 21027
$lanProfiles = "Private,Domain"
$profileRuleSuffixes = @("tcp private", "udp private", "tcp public", "udp public", "discovery private")
$tailnetOnlyRuleSuffixes = @("", "udp")

function Get-FirewallRuleName($Node, [string]$Suffix) {
    $name = "storage-compose syncthing $($Node.id)"
    if ($Suffix) { return "$name $Suffix" }
    return $name
}

function New-FirewallRuleSpec($Node, [string]$Suffix, [string]$Action, [string]$Protocol, [string]$LocalPort, [string]$RemoteAddress, [string]$Profiles) {
    return [pscustomobject]@{
        Name = Get-FirewallRuleName $Node $Suffix; Action = $Action; Protocol = $Protocol; LocalPort = $LocalPort
        RemoteAddress = $RemoteAddress; Profile = $Profiles; Program = $script:syncthingPath
    }
}

function Test-UsesLanMethod($Connections) {
    return [bool]($Connections -and $Connections.PSObject.Properties["options"] -and $Connections.options -and
        $Connections.options.PSObject.Properties["localAnnounceEnabled"] -and $Connections.options.localAnnounceEnabled -eq $true)
}

<#
.NOTES
Without the node's connections entry the node is tailnet-only and keeps the rules it always had: TCP
from the tailnet and a UDP block, so nothing opens on a host that never received the profile. With
it, the sync port is open on Private and Domain networks to any address (the LAN, and what the
router forwards after NAT traversal arrives there too) and on Public networks to the tailnet only.
#>
function Get-NodeFirewallRules($Node, $Ports, $Connections) {
    $port = "$($Ports.listen)"
    if (-not $Connections) {
        return @(
            (New-FirewallRuleSpec $Node "" "Allow" "TCP" $port $tailnetAddressRange "Any"),
            (New-FirewallRuleSpec $Node "udp" "Block" "UDP" "Any" "Any" "Any")
        )
    }
    $rules = @(
        (New-FirewallRuleSpec $Node "tcp private" "Allow" "TCP" $port "Any" $lanProfiles),
        (New-FirewallRuleSpec $Node "udp private" "Allow" "UDP" $port "Any" $lanProfiles),
        (New-FirewallRuleSpec $Node "tcp public" "Allow" "TCP" $port $tailnetAddressRange "Public"),
        (New-FirewallRuleSpec $Node "udp public" "Allow" "UDP" $port $tailnetAddressRange "Public")
    )
    if (Test-UsesLanMethod $Connections) { $rules += New-FirewallRuleSpec $Node "discovery private" "Allow" "UDP" "$localDiscoveryPort" "Any" $lanProfiles }
    return $rules
}

function Get-AllNodeFirewallRuleNames($Node) {
    return @(($tailnetOnlyRuleSuffixes + $profileRuleSuffixes) | ForEach-Object { Get-FirewallRuleName $Node $_ })
}

<#
.NOTES
Windows reports an IPv4 subnet with its mask (100.64.0.0/255.192.0.0) where the rule was made with a
prefix length.
#>
function ConvertTo-PrefixNotation([string]$Address) {
    if ($Address -notmatch '^(\d{1,3}(\.\d{1,3}){3})/(\d{1,3}(\.\d{1,3}){3})$') { return $Address }
    $network = $Matches[1]
    $bits = ([System.Net.IPAddress]::Parse($Matches[3]).GetAddressBytes() | ForEach-Object { [Convert]::ToString($_, 2) }) -join ""
    return "$network/$(($bits.ToCharArray() | Where-Object { $_ -eq '1' }).Count)"
}

<#
.NOTES
Windows reports a rule's profiles as a flags enum ("Domain, Private"), in its own order.
#>
function ConvertTo-ProfileKey([string]$Profiles) {
    return (@($Profiles -split '[,\s]+' | Where-Object { $_ } | Sort-Object) -join ",")
}

<#
.NOTES
A rule made with several ports or addresses is reported as a list, in Windows' own order.
#>
function ConvertTo-ListKey($Values) {
    return (@(@($Values) | ForEach-Object { "$_" -split '[,\s]+' } | Where-Object { $_ } | ForEach-Object { (ConvertTo-PrefixNotation $_).ToLower() } | Sort-Object) -join ",")
}

function Test-FirewallRuleMatches($Existing, $Rule) {
    $ports = $Existing | Get-NetFirewallPortFilter
    $addresses = $Existing | Get-NetFirewallAddressFilter
    $program = ($Existing | Get-NetFirewallApplicationFilter).Program
    return (ConvertTo-ListKey $ports.LocalPort) -eq (ConvertTo-ListKey $Rule.LocalPort) -and "$($ports.Protocol)" -eq $Rule.Protocol -and
        (ConvertTo-ListKey $addresses.RemoteAddress) -eq (ConvertTo-ListKey $Rule.RemoteAddress) -and
        (ConvertTo-ProfileKey "$($Existing.Profile)") -eq (ConvertTo-ProfileKey $Rule.Profile) -and
        "$($Existing.Action)" -eq $Rule.Action -and $program -eq $Rule.Program
}

<#
.NOTES
A rule that differs is changed in place rather than removed and made again, so its port is never
left without a rule in between.
#>
function Set-AgentFirewallRule($Rule, [string]$DisplayName) {
    $existing = Get-NetFirewallRule -Name $Rule.Name -ErrorAction SilentlyContinue
    if (-not $existing) { New-AgentFirewallRule $Rule $DisplayName; return }
    if (Test-FirewallRuleMatches $existing $Rule) { return }
    Set-NetFirewallRule -Name $Rule.Name -Action $Rule.Action -Protocol $Rule.Protocol -LocalPort @($Rule.LocalPort -split ',') `
        -RemoteAddress @($Rule.RemoteAddress -split ',') -Program $Rule.Program -Profile $Rule.Profile
}

<#
.NOTES
Every rule exists before Syncthing first listens. Windows asks "allow access?" for a program no rule
names, and its answer is a rule open to every address that outlives the stack; with rules naming this
program on every profile, it never asks. Rules of the other set (tailnet-only or profile), including
the names an agent before the profile made, are removed by name once the wanted set is in place, so
switching sets leaves none behind and no moment without a rule.
#>
function Set-SyncthingFirewallRule($Node, $Ports, $Connections) {
    $rules = @(Get-NodeFirewallRules $Node $Ports $Connections)
    foreach ($rule in $rules) { Set-AgentFirewallRule $rule "$($rule.Name) ($($Node.name))" }
    $wanted = @($rules | ForEach-Object { $_.Name })
    foreach ($name in Get-AllNodeFirewallRuleNames $Node) {
        if ($wanted -notcontains $name) { Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue }
    }
}

function New-AgentFirewallRule($Rule, [string]$DisplayName) {
    New-NetFirewallRule -Name $Rule.Name -DisplayName $DisplayName -Group $agentFirewallGroup -Direction Inbound `
        -Action $Rule.Action -Protocol $Rule.Protocol -LocalPort @($Rule.LocalPort -split ',') -RemoteAddress @($Rule.RemoteAddress -split ',') `
        -Program $Rule.Program -Profile $Rule.Profile | Out-Null
}

function Remove-NodeFirewallRules($Node) {
    foreach ($name in Get-AllNodeFirewallRuleNames $Node) { Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue }
}

function Get-InstanceFirewallShape($Instance, $Connections) {
    return "$([bool]$Connections) $(Test-UsesLanMethod $Connections) $($Instance.ports.listen)"
}

<#
.NOTES
The profile reaches a running Syncthing through the dashboard's REST calls without a restart, so the
rules follow the connections entry every round; they are only rewritten when its shape changes, and
an instance taken over from an earlier agent has no shape yet, which sets them (and removes the
names an older agent left) on its first round.
#>
function Update-InstanceFirewall($Instance) {
    if ($Instance.state -ne "running" -or -not $Instance.ports) { return }
    $connections = Get-NodeConnections $Instance.node
    if (Test-IsUnreadableConnections $connections) { return }
    if ((Get-InstanceFirewallShape $Instance $connections) -eq $Instance.firewallShape) { return }
    try { Set-InstanceFirewall $Instance $connections } catch { Write-WatcherLog "node $($Instance.node.name) ($($Instance.nodeId)): firewall rules not updated: $_" }
}

function Set-InstanceFirewall($Instance, $Connections) {
    Set-SyncthingFirewallRule $Instance.node $Instance.ports $Connections
    $Instance.firewallShape = Get-InstanceFirewallShape $Instance $Connections
    $Instance.usesLan = Test-UsesLanMethod $Connections
}

<#
.NOTES
The keeper never changes a network's category: Windows gives a Public network no LAN rules, so it
is reported instead, while some running node wants the LAN method.
#>
function Get-LanProblems($Networks, $Instances) {
    if (@($Instances | Where-Object { $_.state -eq "running" -and $_.PSObject.Properties["usesLan"] -and $_.usesLan }).Count -eq 0) { return @() }
    $problems = @()
    foreach ($network in @($Networks | Where-Object { $_.kind -eq "lan" -and $_.PSObject.Properties["category"] -and $_.category -eq "Public" })) {
        $label = $network.address
        if ($network.PSObject.Properties["name"] -and $network.name) { $label = "$($network.name) ($($network.address))" }
        $problems += "LAN unavailable: $label is marked Public"
    }
    return $problems
}

$stackSyncPorts = "22000,22021-22099,22100"
$outsideTailnetRanges = "0.0.0.0-100.63.255.255,100.128.0.0-255.255.255.255,::-fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff,fd7a:115c:a1e1::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
$dockerBackendRuleNames = @(
    "storage-compose docker backend tcp public", "storage-compose docker backend udp public",
    "storage-compose docker backend tcp private", "storage-compose docker backend udp private"
)
$dockerBackendRulesShape = $null

<#
.NOTES
The process Windows' own "Docker Desktop Backend" rules name; the installed copy when it cannot be
read (an elevated process's path is hidden from a non-elevated caller).
#>
function Get-DockerBackendPath {
    $process = Get-Process -Name "com.docker.backend" -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if ($process) { return $process.Path }
    $installed = Join-Path $env:ProgramFiles "Docker\Docker\resources\com.docker.backend.exe"
    if (Test-Path -LiteralPath $installed) { return $installed }
    return $null
}

function New-DockerBackendRule([string]$Protocol, [string]$Network, [string]$Action, [string]$RemoteAddress, [string]$Profiles, [string]$Program) {
    return [pscustomobject]@{
        Name = "storage-compose docker backend $($Protocol.ToLower()) $Network"; Action = $Action; Protocol = $Protocol; LocalPort = $stackSyncPorts
        RemoteAddress = $RemoteAddress; Profile = $Profiles; Program = $Program
    }
}

<#
.NOTES
Spec sections 4, 5 and 9. On a Public network, one the person does not own, Docker Desktop's own
rule admits every address to its published ports, and a Block rule wins over it, so only the
tailnet reaches the stack's sync and relay ports there. On a Private or Domain network Windows has
no rule for the backend (the one it adds when it asks "allow access?" names the Public profile
only), so without the Allow the LAN would never reach a Docker node or the bridge relay.
#>
function Get-DockerBackendRules([string]$Program) {
    return @("TCP", "UDP") | ForEach-Object {
        New-DockerBackendRule $_ "public" "Block" $outsideTailnetRanges "Public" $Program
        New-DockerBackendRule $_ "private" "Allow" "Any" $lanProfiles $Program
    }
}

function Remove-DockerBackendRules {
    foreach ($name in $dockerBackendRuleNames) { Remove-NetFirewallRule -Name $name -ErrorAction SilentlyContinue }
    $script:dockerBackendRulesShape = $null
}

<#
.NOTES
The ports exist only while the stack runs, which is when the rules are kept; they are rewritten
only when the backend's path changes, and they belong to the agent's group, so removing the agent's
rules removes them too.
#>
function Update-DockerBackendRules([bool]$IsActive) {
    if (-not $IsActive) {
        if ($script:dockerBackendRulesShape) { Remove-DockerBackendRules }
        return
    }
    $program = Get-DockerBackendPath
    if (-not $program) {
        if ($script:dockerBackendRulesShape -ne "missing") { Write-WatcherLog "Docker Desktop's backend was not found; the stack's sync ports are neither blocked on Public networks nor opened on Private ones" }
        $script:dockerBackendRulesShape = "missing"
        return
    }
    if ($script:dockerBackendRulesShape -eq $program) { return }
    try {
        foreach ($rule in Get-DockerBackendRules $program) { Set-AgentFirewallRule $rule $rule.Name }
        $script:dockerBackendRulesShape = $program
    } catch { Write-WatcherLog "the Docker backend's rules were not set: $_" }
}

function Get-SyncthingBinFolder {
    if (-not $script:syncthingPath) { return $null }
    return Split-Path (Split-Path $script:syncthingPath)
}

function Remove-SyncthingFirewallRules {
    Remove-NetFirewallRule -Group $agentFirewallGroup -ErrorAction SilentlyContinue
    $script:dockerBackendRulesShape = $null
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
        firewallShape = $null; usesLan = $false
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
        $connections = Get-StartConnections $node
        $identity = Set-SyncthingConfig $node $Instance.ports $ListenHost $connections
        $Instance.apiKey = $identity.apiKey
        $Instance.deviceId = $identity.deviceId
        $Instance.listenAddress = @($identity.listen.addresses)[0]
        $Instance.usesProfile = -not $identity.listen.isTailnetOnly
        Set-InstanceFirewall $Instance $connections
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
    $Instance.firewallShape = $null
    $Instance.usesLan = $false
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
        $addresses = @($document.configuration.options.SelectNodes("listenAddress") | ForEach-Object { $_.InnerText })
        $Instance.listenAddress = $addresses | Select-Object -First 1
        $Instance.usesProfile = $addresses.Count -gt 0 -and -not (Test-IsTailnetOnlyListen $addresses)
    } catch { }
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
            if (Resume-OrphanedSyncthing $instance) { Update-InstanceFirewall $instance; continue }
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
        Update-InstanceFirewall $instance
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
