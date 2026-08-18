$ErrorActionPreference = "Stop"
$TaskName = "ProcessGuard Teams Bridge"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed '$TaskName'."
} else {
    Write-Host "'$TaskName' is not installed."
}
