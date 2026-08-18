$ErrorActionPreference = "Stop"
$BridgeRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StartScript = Join-Path $BridgeRoot "start-bridge.ps1"
$TaskName = "ProcessGuard Teams Bridge"

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$StartScript`"" -WorkingDirectory $BridgeRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Relays ProcessGuard alerts and acknowledgments to Microsoft Teams." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started '$TaskName'."
