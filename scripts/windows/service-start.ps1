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
$env:npm_config_production = "false"

Write-Host "[$(Get-Date -Format o)] Service startup begin"

Invoke-Checked -Command "git" -Arguments @("pull", "origin", "main")

Invoke-Checked -Command "npm" -Arguments @("run", "install:fresh")
Invoke-Checked -Command "npm" -Arguments @("run", "db:generate")
Invoke-Checked -Command "npm" -Arguments @("run", "db:push")
Invoke-Checked -Command "npm" -Arguments @("run", "build")

Write-Host "[$(Get-Date -Format o)] Build complete; starting API"

$env:NODE_ENV = "production"
Invoke-Checked -Command "node" -Arguments @("apps/api/dist/index.js")
