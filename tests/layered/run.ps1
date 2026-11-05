param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('up', 'down')][string]$Action
)

$ErrorActionPreference = 'Continue'

$composeFile = Join-Path $PSScriptRoot 'compose.yml'
$containers = 'layered-test-stick', 'layered-test-keeper', 'layered-test-other'

function Get-LeftoverContainers {
    docker ps -a --filter 'name=^layered-test-' --format '{{.Names}}' | Where-Object { $containers -contains $_ }
}

function Start-Peers {
    docker compose -f $composeFile up -d
    if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }
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
