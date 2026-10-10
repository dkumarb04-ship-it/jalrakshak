# JalRakshak — Cloudflare hosting helper (Windows PowerShell)
#
# WHAT THIS DOES
#   Publishes your locally-running JalRakshak server to the public internet
#   through Cloudflare's edge using a "Quick Tunnel" (cloudflared). No
#   Cloudflare account required. The app code is unchanged.
#
# IMPORTANT
#   - This is a QUICK TUNNEL: the *.trycloudflare.com URL is temporary and
#     changes each time you restart it. It has no uptime guarantee.
#   - Your PC must stay ON and running both `node server.js` and cloudflared
#     for the site to stay reachable.
#   - For a permanent, custom-domain, production setup, use a NAMED tunnel
#     with your Cloudflare account (see README section "Cloudflare (production)").

param(
  [ValidateSet('start','stop','status','url')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$NODE = 'C:\Program Files\nodejs'
$env:Path = "$NODE;$env:Path"
$PORT = if ($env:PORT) { $env:PORT } else { '3000' }
$env:PORT = $PORT
$env:DB_PATH = if ($env:DB_PATH) { $env:DB_PATH } else { 'data/jalrakshak.db' }

function Test-Up { try { $null = Invoke-WebRequest "http://127.0.0.1:$PORT/api/health" -UseBasicParsing -TimeoutSec 4; $true } catch { $false } }

switch ($Action) {
  'start' {
    if (-not (Test-Path '.\cloudflared.exe')) {
      Write-Host 'Downloading cloudflared...' -ForegroundColor Cyan
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe' -UseBasicParsing
    }
    if (-not (Test-Up)) {
      Write-Host "Starting app server on :$PORT ..." -ForegroundColor Cyan
      Start-Process node -ArgumentList 'server.js' -WindowStyle Hidden -RedirectStandardOutput 'run.log' -RedirectStandardError 'run.err'
      Start-Sleep 3
    }
    if (-not (Test-Up)) { Write-Host 'App failed to start. Check run.log / run.err' -ForegroundColor Red; exit 1 }
    Write-Host "App is up on :$PORT. Starting Cloudflare quick tunnel..." -ForegroundColor Green
    Remove-Item 'tunnel.log','tunnel.err' -ErrorAction SilentlyContinue
    Start-Process -FilePath '.\cloudflared.exe' -ArgumentList 'tunnel','--url',"http://localhost:$PORT",'--no-autoupdate' -WindowStyle Hidden -RedirectStandardOutput 'tunnel.log' -RedirectStandardError 'tunnel.err'
    # Wait for the public URL to appear in the log.
    $url = $null
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep 1
      if (Test-Path 'tunnel.err') {
        $m = Select-String -Path 'tunnel.err' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value; break }
      }
    }
    if ($url) {
      Write-Host ''
      Write-Host "  PUBLIC URL:  $url" -ForegroundColor Green
      Write-Host "  Admin:       $url/admin.html  (token: admin-dev-token)" -ForegroundColor Green
      Write-Host "  (Keep this window's processes running. Share the URL to open on any phone.)" -ForegroundColor DarkGray
      $url | Set-Content 'public-url.txt'
    } else {
      Write-Host 'Tunnel started but URL not found yet. Run: .\cloudflare-host.ps1 -Action url' -ForegroundColor Yellow
    }
  }
  'url' {
    if (Test-Path 'public-url.txt') { Get-Content 'public-url.txt' }
    elseif (Test-Path 'tunnel.err') { (Select-String -Path 'tunnel.err' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1).Matches.Value }
    else { 'No active tunnel. Run: .\cloudflare-host.ps1 -Action start' }
  }
  'status' {
    $app = if (Test-Up) { 'UP' } else { 'DOWN' }
    $cf = if (Get-Process cloudflared -ErrorAction SilentlyContinue) { 'RUNNING' } else { 'STOPPED' }
    Write-Host "App: $app   cloudflared: $cf"
    if (Test-Path 'public-url.txt') { Write-Host ("URL: " + (Get-Content 'public-url.txt')) }
  }
  'stop' {
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Stop-Process -Force
    Remove-Item 'public-url.txt' -ErrorAction SilentlyContinue
    Write-Host 'Stopped app + tunnel.' -ForegroundColor Yellow
  }
}
