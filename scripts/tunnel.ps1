$ErrorActionPreference = "Stop"

$raiz = Split-Path $PSScriptRoot -Parent
$destino = Join-Path $raiz ".tools\cloudflared.exe"

if (-not (Test-Path $destino)) {
  New-Item -ItemType Directory -Force (Split-Path $destino) | Out-Null
  $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Write-Host "Descargando cloudflared (solo la primera vez)..."
  Invoke-WebRequest -Uri $url -OutFile $destino -UseBasicParsing
}

Write-Host ""
Write-Host "Túnel público hacia http://localhost:3001"
Write-Host "La URL https://...trycloudflare.com aparece abajo. Mantén esta ventana abierta."
Write-Host ""

& $destino tunnel --url "http://localhost:3001" --no-autoupdate
