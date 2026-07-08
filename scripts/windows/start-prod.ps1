$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root
New-Item -ItemType Directory -Force -Path "$Root\logs" | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = "$Root\logs\processguard-$stamp.log"
"Starting ProcessGuard Andon at $(Get-Date -Format o)" | Out-File -FilePath $log -Encoding utf8
node apps/api/dist/index.js *>> $log
