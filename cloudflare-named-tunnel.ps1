# JalRakshak — Cloudflare NAMED TUNNEL setup (Windows PowerShell)
#
# A named tunnel gives you a STABLE URL (your own domain) with a real uptime
# guarantee, backed by your Cloudflare account. Your PC still runs the app;
# Cloudflare fronts it with HTTPS + your hostname.
#
# WHAT ONLY *YOU* CAN DO:
#   Step 1 (login) opens your browser to authorize Cloudflare. This script
#   cannot click through that for you. Everything else is automated.
#
# USAGE:
#   .\cloudflare-named-tunnel.ps1 -Hostname floods.yourdomain.com
#
# PREREQUISITE: your domain must already be added to your Cloudflare account
#   (DNS managed by Cloudflare). If you don't have a domain yet, use the
#   account-less Quick Tunnel instead:  .\cloudflare-host.ps1 -Action start

param(
  [Parameter(Mandatory = $true)]
  [string]$Hostname,

  [string]$TunnelName = 'jalrakshak',

  [string]$Port = '3000'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:Path = "C:\Program Files\nodejs;$env:Path"

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# --- 0. Ensure cloudflared exists ---------------------------------------------
if (-not (Test-Path '.\cloudflared.exe')) {
  Say 'cloudflared.exe not found — downloading...' Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe' -UseBasicParsing
}

# --- 1. LOGIN (interactive — only you can do this) ----------------------------
$cert = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
if (-not (Test-Path $cert)) {
  Say "`nSTEP 1/4: Cloudflare login (interactive)" Yellow
  Say "A browser window will open. Choose your domain/zone and click Authorize." Yellow
  Say "If no browser opens, copy the URL it prints and open it manually.`n" Yellow
  & '.\cloudflared.exe' tunnel login
  if (-not (Test-Path $cert)) { Say 'Login did not complete (no cert.pem). Aborting.' Red; exit 1 }
  Say 'Login OK.' Green
} else {
  Say 'Already logged in (cert.pem found).' Green
}

# --- 2. Stop any quick tunnel so ports are free -------------------------------
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1

# --- 3. Ensure the app server is running --------------------------------------
try { $null = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 4 }
catch {
  Say "Starting app server on :$Port ..." Cyan
  $env:PORT = $Port
  $env:DB_PATH = if ($env:DB_PATH) { $env:DB_PATH } else { 'data/jalrakshak.db' }
  Start-Process node -ArgumentList 'server.js' -WindowStyle Hidden -RedirectStandardOutput 'run.log' -RedirectStandardError 'run.err'
  Start-Sleep 3
}

# --- 4. Create the tunnel (idempotent) ----------------------------------------
Say "`nSTEP 2/4: Creating named tunnel '$TunnelName'..." Yellow
$listJson = & '.\cloudflared.exe' tunnel list --output json 2>$null | Out-String
$existing = $null
try { $existing = ($listJson | ConvertFrom-Json) | Where-Object { $_.name -eq $TunnelName } } catch {}
if ($existing) {
  $uuid = $existing.id
  Say "Tunnel '$TunnelName' already exists (UUID $uuid)." Green
} else {
  $createOut = & '.\cloudflared.exe' tunnel create $TunnelName 2>&1 | Out-String
  Say $createOut DarkGray
  $m = [regex]::Match($createOut, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
  if (-not $m.Success) { Say 'Could not parse tunnel UUID from create output. Aborting.' Red; exit 1 }
  $uuid = $m.Value
  Say "Created tunnel UUID: $uuid" Green
}

# --- 5. Route DNS (hostname -> tunnel) ----------------------------------------
Say "`nSTEP 3/4: Routing $Hostname -> tunnel..." Yellow
& '.\cloudflared.exe' tunnel route dns $TunnelName $Hostname 2>&1 | ForEach-Object { Say $_ DarkGray }

# --- 6. Write config.yml ------------------------------------------------------
Say "`nSTEP 4/4: Writing config.yml..." Yellow
$cfg = @"
tunnel: $uuid
credentials-file: $PSScriptRoot\.cloudflared\$uuid.json

ingress:
  - hostname: $Hostname
    service: http://localhost:$Port
  - service: http://localhost:$Port
"@
Set-Content -Path (Join-Path $PSScriptRoot 'config.yml') -Value $cfg -Encoding utf8
Say 'config.yml written.' Green

# --- 7. Run the tunnel --------------------------------------------------------
Say "`n=== STARTING NAMED TUNNEL ===" Green
Say "Your app will be reachable at:  https://$Hostname" Green
Say "Admin dashboard:               https://$Hostname/admin.html  (token: admin-dev-token)" Green
Say "Keep this window open. Ctrl+C to stop.`n" DarkGray
& '.\cloudflared.exe' --config (Join-Path $PSScriptRoot 'config.yml') tunnel run $TunnelName
