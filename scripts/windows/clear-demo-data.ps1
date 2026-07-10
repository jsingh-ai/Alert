param(
  [switch]$Alerts,
  [switch]$Messages,
  [switch]$ConfirmClear
)

$ErrorActionPreference = "Stop"

if (-not $Alerts -and -not $Messages) {
  throw "Choose what to clear: -Alerts, -Messages, or both."
}

if (-not $ConfirmClear) {
  throw "This deletes data permanently. Re-run with -ConfirmClear to continue."
}

function Get-EnvValue {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path $Path)) {
    return $null
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }

    $match = [regex]::Match($trimmed, "^\s*$Name\s*=\s*(.+?)\s*$")
    if ($match.Success) {
      return $match.Groups[1].Value.Trim().Trim('"').Trim("'")
    }
  }

  return $null
}

function ConvertTo-PsqlArguments {
  param([string]$DatabaseUrl)

  $uri = [Uri]$DatabaseUrl
  $userInfo = $uri.UserInfo.Split(":", 2)
  $user = [Uri]::UnescapeDataString($userInfo[0])
  $password = if ($userInfo.Length -gt 1) { [Uri]::UnescapeDataString($userInfo[1]) } else { "" }
  $database = $uri.AbsolutePath.TrimStart("/")
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }

  return @{
    Args = @("-h", $uri.Host, "-p", "$port", "-U", $user, "-d", $database, "-v", "ON_ERROR_STOP=1")
    Password = $password
  }
}

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$EnvPath = Join-Path $Root ".env"
$DatabaseUrl = Get-EnvValue -Path $EnvPath -Name "DATABASE_URL"

if (-not $DatabaseUrl) {
  throw "DATABASE_URL was not found in $EnvPath."
}

if (-not (Get-Command psql.exe -ErrorAction SilentlyContinue)) {
  $postgresBin = "C:\Program Files\PostgreSQL\17\bin"
  if (Test-Path $postgresBin) {
    $env:Path += ";$postgresBin"
  }
}

if (-not (Get-Command psql.exe -ErrorAction SilentlyContinue)) {
  throw "psql.exe was not found. Add PostgreSQL bin to PATH, then re-run this script."
}

$connection = ConvertTo-PsqlArguments -DatabaseUrl $DatabaseUrl
$env:PGPASSWORD = $connection.Password

$statements = @()
if ($Alerts) {
  $statements += 'TRUNCATE TABLE "alert_events", "andon_alerts", "andon_commands" RESTART IDENTITY CASCADE;'
}
if ($Messages) {
  $statements += 'TRUNCATE TABLE "communication_messages" RESTART IDENTITY CASCADE;'
  $statements += 'UPDATE "communication_channels" SET "last_message_seq" = 0;'
  $statements += 'UPDATE "communication_channel_members" SET "last_read_seq" = 0;'
}

try {
  foreach ($statement in $statements) {
    Write-Host "Running: $statement"
    & psql.exe @($connection.Args + @("-c", $statement))
    if ($LASTEXITCODE -ne 0) {
      throw "psql failed with exit code $LASTEXITCODE."
    }
  }
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

Write-Host "Clear complete."
