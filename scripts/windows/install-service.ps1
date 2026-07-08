param(
  [string]$ServiceName = "ProcessGuardAndon"
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Open PowerShell as Administrator, then run this script again."
  }
}

function Get-NssmPath {
  $command = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    "$env:ProgramFiles\nssm\win64\nssm.exe",
    "$env:ProgramFiles\nssm\nssm.exe",
    "${env:ProgramFiles(x86)}\nssm\win64\nssm.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-*\win64\nssm.exe"
  )

  foreach ($candidate in $candidates) {
    $match = Get-Item $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) {
      return $match.FullName
    }
  }

  if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
    Write-Host "NSSM was not found. Installing NSSM with winget..."
    winget install -e --id NSSM.NSSM --accept-package-agreements --accept-source-agreements
    $command = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  throw "NSSM was not found. Install it with: winget install -e --id NSSM.NSSM"
}

Assert-Admin

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$StartScript = Join-Path $Root "scripts\windows\service-start.ps1"
$Logs = Join-Path $Root "logs"
$Stdout = Join-Path $Logs "service-out.log"
$Stderr = Join-Path $Logs "service-error.log"
$Nssm = Get-NssmPath

Set-Location $Root
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

git config --system --add safe.directory $Root 2>$null

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
  & $Nssm install $ServiceName powershell.exe
}

& $Nssm set $ServiceName AppParameters "-ExecutionPolicy Bypass -NoProfile -File `"$StartScript`""
& $Nssm set $ServiceName AppDirectory $Root
& $Nssm set $ServiceName DisplayName "ProcessGuard Andon"
& $Nssm set $ServiceName Description "ProcessGuard Andon API and web server"
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName AppStdout $Stdout
& $Nssm set $ServiceName AppStderr $Stderr
& $Nssm set $ServiceName AppRotateFiles 1
& $Nssm set $ServiceName AppRotateBytes 10485760
& $Nssm set $ServiceName AppRotateOnline 1

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service.Status -eq "Running") {
  & $Nssm restart $ServiceName
} else {
  & $Nssm start $ServiceName
}

Write-Host "Installed and started Windows service: $ServiceName"
Write-Host "App folder: $Root"
Write-Host "Logs:"
Write-Host "  $Stdout"
Write-Host "  $Stderr"
