param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('up', 'down', 'status')][string]$Action,
    [string]$ConfigEnv = $(if ($env:STORAGE_CONFIG_ENV) { $env:STORAGE_CONFIG_ENV } else { 'F:\Documents\GitHub\compose\storage-compose\config.env' })
)

$ErrorActionPreference = 'Continue'

$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$container = 'storage-dashboard-test-peer'
$service = 'dashboard-test-peer'
$image = 'ghcr.io/syncthing/syncthing:2.1.6'
$statusVolume = 'storage-compose_storage-status'
$registryFiles = '/status/nodes/d7e5.json /status/nodes/d7e5.syncthing.json /status/nodes/d7e5.json.tmp /status/nodes/d7e5.syncthing.json.tmp'

function Test-PeerExists { [bool](docker ps -a --filter "name=^$container$" --format '{{.Names}}') }

function Start-Peer {
    if (-not (Test-Path $ConfigEnv)) { throw "config.env not found: $ConfigEnv (pass -ConfigEnv or set STORAGE_CONFIG_ENV)" }
    $env:HOST_AGENT_EXPECTED = 'yes'
    Push-Location $repositoryRoot
    try {
        docker compose --env-file $ConfigEnv -f docker-compose.yml -f tests/dashboard/docker-compose.peer.yml up -d --no-deps --no-build $service
        if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }
    } finally { Pop-Location }
}

function Remove-RegistryFiles {
    if (Test-PeerExists) {
        $running = docker ps --filter "name=^$container$" --format '{{.Names}}'
        if ($running) { docker exec $container sh -c "rm -f $registryFiles"; return }
    }
    docker run --rm --entrypoint sh -v "${statusVolume}:/status" $image -c "rm -f $registryFiles" | Out-Null
}

function Stop-Peer {
    Remove-RegistryFiles
    if (Test-PeerExists) { docker rm -f -v $container | Out-Null }
}

function Show-PeerStatus {
    if (-not (Test-PeerExists)) { Write-Output 'peer is down'; return }
    $key = docker exec $container sh -c "sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' /var/syncthing/config/config.xml"
    $status = docker exec $container wget -qO- --header "X-API-Key: $key" http://127.0.0.1:8389/rest/system/status | ConvertFrom-Json
    Write-Output "device ID: $($status.myID)"
    $dialAddress = Get-PcDialAddress
    if ($dialAddress) { Write-Output "pc dial address: $dialAddress" }
}

function Get-PcDialAddress {
    $heartbeat = docker exec storage-dashboard cat /host-agent/heartbeat.json | ConvertFrom-Json
    $pc = $heartbeat.nodes | Where-Object { $_.id -eq 'fb98' } | Select-Object -First 1
    if ($pc -and $pc.syncthing.listenPort) { return "tcp://host.docker.internal:$($pc.syncthing.listenPort)" }
}

switch ($Action) {
    'up' { Start-Peer }
    'down' { Stop-Peer }
    'status' { Show-PeerStatus }
}
