# dsh-anti-interrupt boot guard.
# Runs from a scheduled task once a minute. If the DSH app is not running, starts it.
# Installed and removed by the plugin itself (nightwatch action=guard).
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.

param(
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$Image,
    [string]$Log = '',
    [string]$WorkDir = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Log([string]$message) {
    if ([string]::IsNullOrWhiteSpace($Log)) { return }
    $line = '{0} {1}' -f (Get-Date).ToString('o'), $message
    try { $line | Out-File -Append -Encoding utf8 -FilePath $Log } catch { }
}

$running = @(Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($Image)) -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Log ('alive: {0} pid(s) {1}' -f $Image, (($running | ForEach-Object { $_.Id }) -join ','))
    exit 0
}

if ($DryRun) {
    Write-Log ('dry-run: {0} not running, would start {1}' -f $Image, $Launcher)
    exit 2
}

if (-not (Test-Path -LiteralPath $Launcher)) {
    Write-Log ('missing launcher: {0}' -f $Launcher)
    exit 3
}

# Strip inherited DSH_* so the app does not pick up a profile from whatever spawned the task.
Get-ChildItem env: | Where-Object { $_.Name -like 'DSH_*' } | ForEach-Object {
    Remove-Item -Path ('env:' + $_.Name) -ErrorAction SilentlyContinue
}

$startInfo = @{ FilePath = $Launcher }
if (-not [string]::IsNullOrWhiteSpace($WorkDir) -and (Test-Path -LiteralPath $WorkDir)) {
    $startInfo['WorkingDirectory'] = $WorkDir
}

try {
    Start-Process @startInfo
    Write-Log ('started {0}' -f $Launcher)
    exit 0
} catch {
    Write-Log ('start failed: {0}' -f $_.Exception.Message)
    exit 4
}
