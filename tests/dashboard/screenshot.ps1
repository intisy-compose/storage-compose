param(
    [Parameter(Mandatory)][string]$Route,
    [Parameter(Mandatory)][string]$Out,
    [string]$Url = 'http://localhost:8442',
    [int]$Width = 1440,
    [int]$Height = 1600,
    [string]$Browser = '',
    [int]$TimeoutSeconds = 60
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

<#
.NOTES
Ends the browser this run started and every process of it: the tree below its first process, and any
process that still names this run's own profile folder, which only this run's browser does.
#>
function Stop-RunBrowser([System.Diagnostics.Process]$process, [string]$profile) {
    if ($process -and -not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F 2>&1 | Out-Null }
    $profileName = Split-Path -Leaf $profile
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileName) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if (-not $Browser) { $Browser = Find-HeadlessShell }
if (-not (Test-Path $Browser)) { throw "browser not found: $Browser" }
if ($TimeoutSeconds -lt 1) { throw "TimeoutSeconds must be 1 or more" }

$outPath = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path $outPath) | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $outPath
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ("dashboard-shot-" + [guid]::NewGuid().ToString('N'))
$browserProcess = $null
$timedOut = $false

try {
    $browserArguments = @(
        '--hide-scrollbars',
        "--window-size=$Width,$Height",
        '--virtual-time-budget=8000',
        "--user-data-dir=`"$profile`"",
        "--screenshot=`"$outPath`"",
        "$($Url.TrimEnd('/'))/#/$($Route.TrimStart('/#'))"
    )
    $browserProcess = Start-Process -FilePath $Browser -ArgumentList $browserArguments -NoNewWindow -PassThru
    $null = $browserProcess.Handle
    $timedOut = -not $browserProcess.WaitForExit($TimeoutSeconds * 1000)
} finally {
    Stop-RunBrowser $browserProcess $profile
    Remove-Profile $profile
}

if ($timedOut) {
    Remove-Item -Force -ErrorAction SilentlyContinue $outPath
    throw "the browser did not finish within $TimeoutSeconds s; it was ended and no screenshot was taken"
}
if ($browserProcess.ExitCode -ne 0) { throw "browser exited with code $($browserProcess.ExitCode)" }
if (-not (Test-Path $outPath)) { throw "no screenshot written to $outPath" }
Write-Output $outPath
