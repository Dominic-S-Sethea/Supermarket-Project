# SupermarketOS — One-Step Windows Setup Script
# Run from anywhere: powershell -ExecutionPolicy Bypass -File scripts/setup-windows.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

Push-Location $RepoRoot
try {
  Write-Host "=== 1. Installing TypeScript workspace dependencies (pnpm) ===" -ForegroundColor Cyan
  pnpm.cmd install
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "=== 2. Building @supermarket/shared ===" -ForegroundColor Cyan
  pnpm.cmd --filter @supermarket/shared build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "=== 3. Starting PostgreSQL 16 via Docker Desktop ===" -ForegroundColor Cyan
  pnpm.cmd db:up
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Start-Sleep -Seconds 4

  Write-Host "=== 4. Running versioned Drizzle migrations & seeding 3,120 SKUs ===" -ForegroundColor Cyan
  pnpm.cmd db:migrate
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  pnpm.cmd db:seed
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "=== 5. Syncing Python analytics env (uv) & running ML worker ===" -ForegroundColor Cyan
  uv --directory services/analytics sync --frozen
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  pnpm.cmd analytics:run
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host ""
  Write-Host "Setup complete! Start the app in two terminals from ${RepoRoot}:" -ForegroundColor Green
  Write-Host "  Terminal 1 (API): pnpm.cmd dev:api" -ForegroundColor White
  Write-Host "  Terminal 2 (Web): pnpm.cmd dev:web" -ForegroundColor White
  Write-Host "Then open: http://localhost:5173" -ForegroundColor Green
} finally {
  Pop-Location
}
