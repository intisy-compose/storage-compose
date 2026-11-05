param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('up', 'down')][string]$Action
)

$ErrorActionPreference = 'Continue'

$composeFile = Join-Path $PSScriptRoot 'compose.yml'
$seedScript = Join-Path $PSScriptRoot 'seed-config.sh'
$image = 'ghcr.io/syncthing/syncthing:2.1.6'
$containers = 'layered-test-stick', 'layered-test-keeper', 'layered-test-other'

function Get-LeftoverContainers {
    docker ps -a --filter 'name=^layered-test-' --format '{{.Names}}' | Where-Object { $containers -contains $_ }
}

function Start-Peers {
    docker compose -f $composeFile create
    if ($LASTEXITCODE -ne 0) { throw 'docker compose create failed' }
    foreach ($container in $containers) {
        docker run --rm --network none --volumes-from $container -v "${seedScript}:/seed-config.sh:ro" --entrypoint sh $image /seed-config.sh
        if ($LASTEXITCODE -ne 0) { throw "seeding the config of $container failed" }
    }
    docker compose -f $composeFile start
    if ($LASTEXITCODE -ne 0) { throw 'docker compose start failed' }
}

function Stop-Peers {
    docker compose -f $composeFile down -v --remove-orphans --timeout 5
    if ($LASTEXITCODE -ne 0) { throw 'docker compose down failed' }
    $leftover = @(Get-LeftoverContainers)
    if ($leftover.Count -gt 0) { throw "still present after down: $($leftover -join ', ')" }
}

switch ($Action) {
    'up' { Start-Peers }
    'down' { Stop-Peers }
}
