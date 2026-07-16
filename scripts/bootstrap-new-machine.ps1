$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') {
  throw "Node.js 24.x is required. Found: $nodeVersion"
}

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

npm run format:check
if ($LASTEXITCODE -ne 0) { throw 'Formatting check failed' }

npm run check
if ($LASTEXITCODE -ne 0) { throw 'Project quality checks failed' }

npm audit --audit-level=low
if ($LASTEXITCODE -ne 0) { throw 'Full dependency audit failed' }

npm audit --omit=dev --audit-level=low
if ($LASTEXITCODE -ne 0) { throw 'Production dependency audit failed' }

npm run wechat:preflight -- --strict-online
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'WeChat preflight has blockers. This is expected until real AppID and API domain are configured.'
}

Write-Host 'New-machine source checks completed. Review HANDOFF.md and out/wechat-preflight.json.'
