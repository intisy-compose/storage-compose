# A joined node's connections entry, as the dashboard answers it at GET /api/connections/node/<id>
# (specs/2026-11-02-connection-methods-design.md). Shared by the join's start step and the host agent's
# joined mode; dot-sourced, defines functions only.

$dashboardEntryTimeoutSeconds = 10

function Get-JoinedConnectionsNodeId([string]$DeviceId) { return "device-$($DeviceId.Substring(0, 7).ToLower())" }

function ConvertFrom-ConnectionsText([string]$Text) {
    try { $entry = $Text | ConvertFrom-Json } catch { return $null }
    if ($entry -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    return $entry
}

<#
.NOTES
Waits on the request as a task, so the bound covers the whole request: on .NET Framework the timeouts
of Invoke-WebRequest and HttpClient leave out the name lookup, which can take 15 s and more.
#>
function Get-DashboardEntryText([string]$Dashboard, [string]$NodeId) {
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    try {
        $request = $client.GetStringAsync("$($Dashboard.TrimEnd('/'))/api/connections/node/$NodeId")
        if (-not $request.Wait([TimeSpan]::FromSeconds($dashboardEntryTimeoutSeconds))) { throw "no answer within $dashboardEntryTimeoutSeconds s" }
        return $request.Result
    } finally {
        $client.Dispose()
    }
}

<#
.NOTES
The dashboard assumes 22000 for every joined device and leaves the device's own port to the device.
#>
function ConvertTo-OwnListenPort($Address, [string]$ListenPort) {
    if ($Address -isnot [string] -or $ListenPort -notmatch '^\d+$' -or $Address -cnotmatch '^(tcp|quic)[46]?://') { return $Address }
    return $Address -replace ':\d+((?:[/?].*)?)$', ":$ListenPort`$1"
}

function Set-OwnListenPort($Entry, [string]$ListenPort) {
    if (-not ($Entry.PSObject.Properties["listenAddresses"] -and $Entry.listenAddresses -is [array])) { return }
    $Entry.listenAddresses = @($Entry.listenAddresses | ForEach-Object { ConvertTo-OwnListenPort $_ $ListenPort })
}
