# Pester 3.4, shipped with Windows: Invoke-Pester -Script tests\dashboard\screenshot.Tests.ps1
$screenshot = Join-Path $PSScriptRoot 'screenshot.ps1'

function Get-MarkedProcesses([string]$marker) {
    @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($marker) })
}

Describe 'screenshot.ps1' {
    It 'ends a browser that hangs after its timeout, fails naming it, and leaves nothing running' {
        $marker = "127.$(Get-Random -Minimum 1 -Maximum 254).$(Get-Random -Minimum 1 -Maximum 254).$(Get-Random -Minimum 1 -Maximum 254)"
        $hangingBrowser = Join-Path $TestDrive 'hanging-browser.cmd'
        Set-Content -LiteralPath $hangingBrowser -Value "@ping -n 120 $marker > nul" -Encoding ASCII
        $out = Join-Path $TestDrive 'shot.png'
        $clock = [System.Diagnostics.Stopwatch]::StartNew()

        { & $screenshot -Route 'nodes' -Out $out -Browser $hangingBrowser -TimeoutSeconds 2 } | Should Throw 'did not finish within 2 s'

        $clock.Elapsed.TotalSeconds | Should BeLessThan 30
        Start-Sleep -Milliseconds 500
        (Get-MarkedProcesses $marker).Count | Should Be 0
        Test-Path $out | Should Be $false
    }

    It 'refuses a timeout below one second' {
        { & $screenshot -Route 'nodes' -Out (Join-Path $TestDrive 'shot.png') -Browser $env:ComSpec -TimeoutSeconds 0 } | Should Throw 'TimeoutSeconds must be 1 or more'
    }
}
