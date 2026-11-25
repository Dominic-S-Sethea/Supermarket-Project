# SupermarketOS — One-Step Windows Setup Script
# Run from: C:\Users\Reinh\OneDrive\Desktop\Supermarket Project

$ErrorActionPreference = "Stop"

Write-Host "=== 1. Installing TypeScript workspace dependencies (pnpm) ===" -ForegroundColor Cyan
pnpm.cmd install

Write-Host "=== 2. Building @supermarket/shared ===" -ForegroundColor Cyan
pnpm.cmd --filter @supermarket/shared build

Write-Host "=== 3. Starting PostgreSQL 16 via Docker Desktop ===" -ForegroundColor Cyan
pnpm.cmd db:up
Start-Sleep -Seconds 4

Write-Host "=== 4. Pushing Drizzle schema & seeding 3,120 SKUs ===" -ForegroundColor Cyan
pnpm.cmd db:push
pnpm.cmd db:seed

Write-Host "=== 5. Syncing Python analytics env (uv) & running ML worker ===" -ForegroundColor Cyan
uv --directory services/analytics sync
pnpm.cmd analytics:run

Write-Host ""
Write-Host "Setup complete! Start the app in two terminals:" -ForegroundColor Green
Write-Host "  Terminal 1 (API): pnpm.cmd dev:api" -ForegroundColor White
Write-Host "  Terminal 2 (Web): pnpm.cmd dev:web" -ForegroundColor White
Write-Host "Then open: http://localhost:5173" -ForegroundColor Green
