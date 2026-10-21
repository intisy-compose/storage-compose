param(
    [Parameter(Mandatory)][string]$Route,
    [Parameter(Mandatory)][string]$Out,
    [string]$Url = 'http://localhost:8442',
    [int]$Width = 1440,
    [int]$Height = 1600,
    [string]$Browser = ''
)

$ErrorActionPreference = 'Stop'

function Find-HeadlessShell {
    $pattern = Join-Path $env:LOCALAPPDATA 'ms-playwright\chromium_headless_shell-*\*\chrome-headless-shell.exe'
    $newest = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
        Sort-Object { [int](($_.FullName -replace '.*chromium_headless_shell-(\d+).*', '$1')) } -Descending |
        Select-Object -First 1
    if (-not $newest) { throw "no headless shell found, looked in $pattern" }
    return $newest.FullName
}

function Remove-Profile([string]$profile) {
    for ($attempt = 0; $attempt -lt 10 -and (Test-Path $profile); $attempt++) {
        Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
        if (Test-Path $profile) { Start-Sleep -Milliseconds 300 }
    }
}

if (-not $Browser) { $Browser = Find-HeadlessShell }
if (-not (Test-Path $Browser)) { throw "browser not found: $Browser" }

$outPath = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path $outPath) | Out-Null
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("dashboard-shot-" + [guid]::NewGuid().ToString('N'))

try {
    $browserArguments = @(
        '--hide-scrollbars',
        "--window-size=$Width,$Height",
        '--virtual-time-budget=8000',
        "--user-data-dir=`"$profile`"",
        "--screenshot=`"$outPath`"",
        "$($Url.TrimEnd('/'))/#/$($Route.TrimStart('/#'))"
    )
    Start-Process -FilePath $Browser -ArgumentList $browserArguments -Wait -NoNewWindow | Out-Null
} finally {
    Remove-Profile $profile
}

if (-not (Test-Path $outPath)) { throw "no screenshot written to $outPath" }
Write-Output $outPath
