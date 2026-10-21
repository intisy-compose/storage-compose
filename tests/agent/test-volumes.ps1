# Small NTFS test volumes on dynamic VHDX files, made and removed with diskpart (shipped with
# Windows; needs an admin shell). Dot-sourced by the end-to-end tests; defines functions only.

function Invoke-Diskpart([string[]]$Lines) {
    $script = Join-Path ([System.IO.Path]::GetTempPath()) "agent-diskpart-$([guid]::NewGuid()).txt"
    [System.IO.File]::WriteAllText($script, ($Lines -join "`r`n") + "`r`n")
    try {
        $output = & diskpart.exe /s $script 2>&1 | ForEach-Object { "$_" }
        if ($LASTEXITCODE -ne 0) { throw "diskpart failed: $($output -join ' ')" }
        return $output
    } finally { Remove-Item -Force -ErrorAction SilentlyContinue $script }
}

function Get-FreeDriveLetter {
    $used = @(Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Name.ToUpper() }) + @(Get-Volume | Where-Object DriveLetter | ForEach-Object { "$($_.DriveLetter)" })
    foreach ($letter in [char[]]"ZYXWVUTSRQPONMLKJIHG") { if ("$letter" -notin $used) { return "$letter" } }
    throw "no free drive letter"
}

function New-TestVolume([string]$Path, [string]$Label, [int]$SizeMegabytes = 64) {
    $letter = Get-FreeDriveLetter
    Invoke-Diskpart @(
        "create vdisk file=`"$Path`" maximum=$SizeMegabytes type=expandable",
        "select vdisk file=`"$Path`"", "attach vdisk", "convert gpt", "create partition primary",
        "format fs=ntfs quick label=$Label", "assign letter=$letter"
    ) | Out-Null
    return "${letter}:\"
}

function Mount-TestVolume([string]$Path) {
    $letter = Get-FreeDriveLetter
    Invoke-Diskpart @("select vdisk file=`"$Path`"", "attach vdisk") | Out-Null
    Start-Sleep -Seconds 2
    $partition = Get-DiskImage -ImagePath $Path | Get-Disk | Get-Partition | Where-Object { $_.Type -eq "Basic" } | Select-Object -First 1
    if (-not $partition.DriveLetter -or "$($partition.DriveLetter)" -eq "`0") { $partition | Set-Partition -NewDriveLetter $letter }
    return "$((Get-DiskImage -ImagePath $Path | Get-Disk | Get-Partition | Where-Object { $_.Type -eq 'Basic' } | Select-Object -First 1).DriveLetter):\"
}

function Dismount-TestVolume([string]$Path) {
    if ((Get-DiskImage -ImagePath $Path -ErrorAction SilentlyContinue).Attached) { Invoke-Diskpart @("select vdisk file=`"$Path`"", "detach vdisk") | Out-Null }
}

function Remove-TestVolume([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Dismount-TestVolume $Path
    Remove-Item -Force -LiteralPath $Path
}

function Write-TestNodeFile([string]$Folder, [string]$Id, [string]$Name, [string]$Kind) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Folder ".storage") | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $Folder ".storage\node.toml"), "[node]`nid = `"$Id`"`nname = `"$Name`"`nkind = `"$Kind`"`nthreshold = 80`nassigned = []`n")
}
