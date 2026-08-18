$ErrorActionPreference = "Stop"
$BridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $BridgeRoot

if (-not (Test-Path -LiteralPath ".env")) {
    Write-Host "Missing .env. Copy .env.example to .env and enter the bridge settings." -ForegroundColor Red
    exit 1
}

node src/index.mjs
