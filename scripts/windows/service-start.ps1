$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Logs = Join-Path $Root "logs"
$OutLog = Join-Path $Logs "service-out.log"

Set-Location $Root
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$env:NODE_ENV = "production"

"[$(Get-Date -Format o)] Service startup begin" | Out-File -FilePath $OutLog -Append -Encoding utf8

git pull origin main

npm run install:fresh
npm run db:generate
npm run db:push
npm run build

"[$(Get-Date -Format o)] Build complete; starting API" | Out-File -FilePath $OutLog -Append -Encoding utf8

node apps/api/dist/index.js
