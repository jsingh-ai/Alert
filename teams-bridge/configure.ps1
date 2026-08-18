$ErrorActionPreference = "Stop"
$BridgeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $BridgeRoot ".env"

function Read-Secret([string]$Prompt) {
    $Secure = Read-Host $Prompt -AsSecureString
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer) }
}

function Quote-Env([string]$Value) {
    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw "Configuration values cannot contain quotes or line breaks."
    }
    return '"' + $Value + '"'
}

Write-Host "ProcessGuard Teams Bridge configuration" -ForegroundColor Cyan
Write-Host "The values entered here stay in the local .env file."

$Webhook = Read-Host "Existing/default Power Automate Workflow webhook URL"
$QualityWebhook = Read-Host "Quality channel Workflow URL (optional; Enter uses default)"
$SupervisorWebhook = Read-Host "Supervisor channel Workflow URL (optional; Enter uses default)"
$MaintenanceWebhook = Read-Host "Maintenance channel Workflow URL (optional; Enter uses default)"
$QualityToken = Read-Secret "Quality ProcessGuard pager/integration token (hidden)"
$SupervisorToken = Read-Secret "Supervisor ProcessGuard pager/integration token (hidden)"
$MaintenanceToken = Read-Secret "Maintenance ProcessGuard pager/integration token (hidden; may be blank)"
$LanAddress = Read-Host "ProcessGuard computer LAN address [10.8.10.97]"
if ([string]::IsNullOrWhiteSpace($LanAddress)) { $LanAddress = "10.8.10.97" }

$RandomBytes = New-Object byte[] 32
$RandomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $RandomGenerator.GetBytes($RandomBytes) }
finally { $RandomGenerator.Dispose() }
$AckSecret = [Convert]::ToBase64String($RandomBytes)

$Lines = @(
    'PROCESSGUARD_BASE_URL="http://127.0.0.1:5003"',
    ('BRIDGE_PUBLIC_URL=' + (Quote-Env "http://${LanAddress}:5010")),
    'BRIDGE_BIND_HOST="0.0.0.0"',
    'BRIDGE_PORT=5010',
    ('TEAMS_WORKFLOW_WEBHOOK_URL=' + (Quote-Env $Webhook)),
    ('QUALITY_TEAMS_WEBHOOK_URL=' + (Quote-Env $QualityWebhook)),
    ('SUPERVISOR_TEAMS_WEBHOOK_URL=' + (Quote-Env $SupervisorWebhook)),
    ('MAINTENANCE_TEAMS_WEBHOOK_URL=' + (Quote-Env $MaintenanceWebhook)),
    ('QUALITY_PAGER_TOKEN=' + (Quote-Env $QualityToken)),
    ('SUPERVISOR_PAGER_TOKEN=' + (Quote-Env $SupervisorToken)),
    ('MAINTENANCE_PAGER_TOKEN=' + (Quote-Env $MaintenanceToken)),
    ('ACK_LINK_SECRET=' + (Quote-Env $AckSecret)),
    'ACK_LINK_TTL_MINUTES=1440',
    'POLL_INTERVAL_MS=5000',
    'HTTP_TIMEOUT_MS=7000',
    'NOTIFY_EXISTING_ALERTS_ON_START=false',
    'ACK_RESPONDER_PREFIX="Teams"',
    'STATE_FILE="./data/state.json"'
)

Set-Content -LiteralPath $EnvPath -Value $Lines -Encoding UTF8
Write-Host "Saved $EnvPath" -ForegroundColor Green
Write-Host "Next: run .\start-bridge.ps1"
