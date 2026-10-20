# Pester 3.4: removing every inbound rule for the stack's Syncthing binaries, against real Windows
# Firewall rules (admin). The rules are made disabled and for program paths in a temporary folder, so
# they never open anything; the one outside the folder is removed again at the end.

$repository = Split-Path (Split-Path $PSScriptRoot)
. (Join-Path $repository "windows\agent-files.ps1")

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) "agent-firewall-$([guid]::NewGuid())"
$bin = Join-Path $scratch "storage-compose\host-agent\bin"
$tag = "storage-compose firewall test $([guid]::NewGuid())"

function New-TestRule([string]$Name, [string]$Program, [string]$Group = "", [string]$Protocol = "TCP") {
    $arguments = @{ Name = "$tag $Name"; DisplayName = "$tag $Name"; Direction = "Inbound"; Action = "Allow"; Protocol = $Protocol; Program = $Program; Enabled = "False"; Profile = "Any" }
    if ($Group) { $arguments["Group"] = $Group }
    New-NetFirewallRule @arguments | Out-Null
}

function Test-RuleExists([string]$Name) { return [bool](Get-NetFirewallRule -Name "$tag $Name" -ErrorAction SilentlyContinue) }

Describe "removing the rules of the stack's Syncthing binaries" {
    $agentBinary = Join-Path $bin "syncthing-v2.1.6-windows-amd64\syncthing.exe"
    New-TestRule "agent" $agentBinary $agentFirewallGroup
    New-TestRule "windows tcp" $agentBinary.ToLower()
    New-TestRule "windows udp" $agentBinary.ToLower() "" "UDP"
    New-TestRule "older version" (Join-Path $bin "syncthing-v2.1.5-windows-amd64\syncthing.exe")
    New-TestRule "other program" (Join-Path $scratch "elsewhere\syncthing.exe")
    New-TestRule "sibling folder" (Join-Path $scratch "storage-compose\host-agent\binaries\syncthing.exe")

    Remove-ProgramFirewallRules $bin

    It "removes the agent's own rule" { Test-RuleExists "agent" | Should Be $false }
    It "removes the rules Windows made for the binary, whatever their case or protocol" {
        Test-RuleExists "windows tcp" | Should Be $false
        Test-RuleExists "windows udp" | Should Be $false
    }
    It "removes the rule of an older binary in the same folder" { Test-RuleExists "older version" | Should Be $false }
    It "leaves a program outside the folder alone" { Test-RuleExists "other program" | Should Be $true }
    It "leaves a folder that only starts with the same name alone" { Test-RuleExists "sibling folder" | Should Be $true }

    Get-NetFirewallRule -DisplayName "$tag *" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    It "leaves nothing of the test behind" { @(Get-NetFirewallRule -DisplayName "$tag *" -ErrorAction SilentlyContinue).Count | Should Be 0 }
}
