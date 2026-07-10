$ErrorActionPreference = "Stop"

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  Write-Host "[$(Get-Date -Format o)] Running: $Command $($Arguments -join ' ')"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
  }
}

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Logs = Join-Path $Root "logs"

Set-Location $Root
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$env:NODE_ENV = $null

Write-Host "[$(Get-Date -Format o)] Service startup begin"

if (-not (Test-Path (Join-Path $Root "apps\api\dist\index.js"))) {
  throw "Built API was not found. Run scripts\windows\deploy-update.ps1 before starting the service."
}

Write-Host "[$(Get-Date -Format o)] Starting API"

$env:NODE_ENV = "production"
Invoke-Checked -Command "node" -Arguments @("apps/api/dist/index.js")
