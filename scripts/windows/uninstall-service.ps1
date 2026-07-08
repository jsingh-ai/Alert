param(
  [string]$ServiceName = "ProcessGuardAndon"
)

$ErrorActionPreference = "Stop"

$command = Get-Command nssm.exe -ErrorAction SilentlyContinue
if (-not $command) {
  throw "NSSM was not found in PATH. Add NSSM to PATH or uninstall the service from Services."
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  & $command.Source stop $ServiceName
  & $command.Source remove $ServiceName confirm
  Write-Host "Removed Windows service: $ServiceName"
} else {
  Write-Host "Windows service not found: $ServiceName"
}
