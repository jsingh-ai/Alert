$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Logs = Join-Path $Root "logs"

Set-Location $Root
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$env:NODE_ENV = "production"

Write-Host "[$(Get-Date -Format o)] Service startup begin"

git pull origin main

npm run install:fresh
npm run db:generate
npm run db:push
npm run build

Write-Host "[$(Get-Date -Format o)] Build complete; starting API"

node apps/api/dist/index.js
