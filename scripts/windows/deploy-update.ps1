param(
  [switch]$SkipPull,
  [switch]$SkipMigrate
)

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

Set-Location $Root

$env:NODE_ENV = $null
$env:npm_config_production = "false"

Write-Host "[$(Get-Date -Format o)] Deploy update begin"

if (-not $SkipPull) {
  Invoke-Checked -Command "git" -Arguments @("pull", "origin", "main")
}

Invoke-Checked -Command "npm" -Arguments @("run", "install:fresh")
Invoke-Checked -Command "npm" -Arguments @("run", "db:generate")

if (-not $SkipMigrate) {
  Invoke-Checked -Command "npm" -Arguments @("run", "db:migrate")
}

Invoke-Checked -Command "npm" -Arguments @("run", "build")

Write-Host "[$(Get-Date -Format o)] Deploy update complete"
