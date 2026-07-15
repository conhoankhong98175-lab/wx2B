$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$appName = -join @([char]0x5E97, [char]0x544A, [char]0x62A5, [char]0x4EF7, [char]0x52A9, [char]0x624B)
if (-not $env:ELECTRON_MIRROR) {
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}

$assets = Join-Path $Root 'assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
$iconPath = Join-Path $assets 'icon.ico'

if (-not (Test-Path -LiteralPath $iconPath)) {
  Add-Type -AssemblyName System.Drawing
  $bitmap = New-Object System.Drawing.Bitmap 256, 256
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(11, 107, 95))
  $font = New-Object System.Drawing.Font 'Microsoft YaHei', 116, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(228, 190, 90))
  $rect = New-Object System.Drawing.RectangleF 0, 0, 256, 246
  $graphics.DrawString([string][char]0x5E97, $font, $brush, $rect, $format)
  $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
  $stream = [System.IO.File]::Create($iconPath)
  $icon.Save($stream)
  $stream.Close()
  $icon.Dispose()
  $brush.Dispose()
  $format.Dispose()
  $font.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

npm run format:check
if ($LASTEXITCODE -ne 0) { throw 'Project formatting check failed' }
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Project quality checks or build failed' }
npm run package:windows
if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed' }

$packageDirectory = Join-Path $Root 'out\DiangaoQuoteAssistant-win32-x64'
if (-not (Test-Path -LiteralPath $packageDirectory -PathType Container)) {
  throw 'Packaged Windows directory not found'
}
$zipDirectory = Join-Path $Root 'out\make\zip\win32\x64'
New-Item -ItemType Directory -Force -Path $zipDirectory | Out-Null
$zipPath = Join-Path $zipDirectory ($appName + '-win32-x64-1.0.0.zip')
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $packageDirectory '*') -DestinationPath $zipPath -CompressionLevel Optimal

$zip = Get-Item -LiteralPath $zipPath -ErrorAction Stop

$outRoot = [System.IO.Path]::GetFullPath((Join-Path $Root 'out'))
$smokeFolder = (-join @([char]0x4E2D, [char]0x6587)) + ' ' + (-join @([char]0x7A7A, [char]0x683C)) + ' ' + (-join @([char]0x9A8C, [char]0x8BC1))
$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $outRoot 'smoke') $smokeFolder))
if (-not $smokeRoot.StartsWith($outRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Smoke test target escaped the workspace out directory'
}
if (Test-Path -LiteralPath $smokeRoot) {
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $smokeRoot
$forbiddenFiles = Get-ChildItem -LiteralPath $smokeRoot -Recurse -File | Where-Object {
  $_.Name -like '.env*' -or
  $_.Name -eq '.local-secret' -or
  $_.Name -like '*Cookies*' -or
  $_.Name -like '*.db*' -or
  $_.Name -eq 'desktop-smoke.png' -or
  $_.FullName -match '[\\/](?:smoke-data|release-smoke)[\\/]'
}
if ($forbiddenFiles) {
  $forbiddenNames = ($forbiddenFiles | Select-Object -First 10 -ExpandProperty FullName) -join ', '
  throw "Sensitive files found in Windows ZIP: $forbiddenNames"
}
$expectedExeName = $appName + '.exe'
$smokeExe = Get-ChildItem -LiteralPath $smokeRoot -Recurse -Filter '*.exe' |
  Where-Object { $_.Name -eq $expectedExeName } |
  Select-Object -First 1
if (-not $smokeExe) { throw 'Packaged executable not found after extraction' }
$smokeDataName = (-join @([char]0x72EC, [char]0x7ACB)) + ' User Data'
$smokeData = Join-Path $smokeRoot $smokeDataName
New-Item -ItemType Directory -Force -Path $smokeData | Out-Null
$smokeArguments = @('--smoke-test', "--user-data-dir=`"$smokeData`"")
$smokeProcess = Start-Process -FilePath $smokeExe.FullName -ArgumentList $smokeArguments -WindowStyle Hidden -Wait -PassThru
if ($smokeProcess.ExitCode -ne 0) { throw "Packaged desktop smoke test failed: $($smokeProcess.ExitCode)" }
Write-Host 'Packaged desktop smoke test passed in a CJK path containing spaces.'

$release = Join-Path $Root 'release'
New-Item -ItemType Directory -Force -Path $release | Out-Null
Get-ChildItem -LiteralPath $release -File | Where-Object {
  $_.Name -like '*.zip' -or $_.Name -like '*.zip.sha256'
} | Remove-Item -Force
$releaseZip = Join-Path $release $zip.Name
Copy-Item -LiteralPath $zip.FullName -Destination $releaseZip -Force

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $releaseZip
[System.IO.File]::WriteAllText(
  "$releaseZip.sha256",
  "$($hash.Hash)  $($zip.Name)`n",
  $utf8NoBom
)

Write-Host "Windows portable release created: $release"
