$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
$checksums = Invoke-RestMethod -Uri 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt'
$releaseLine = $checksums -split "`n" | Where-Object { $_ -match 'win-x64.zip$' } | Select-Object -First 1
$parts = $releaseLine.Trim() -split '\s+'
$archive = Join-Path $toolsDirectory $parts[1]
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri ('https://nodejs.org/dist/latest-v24.x/' + $parts[1]) -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $parts[0]) { throw 'Node archive checksum verification failed.' }
Expand-Archive -LiteralPath $archive -DestinationPath $toolsDirectory -Force
Push-Location $projectRoot
try {
  & '.\npm.cmd' ci --cache .tools/npm-cache
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  & '.\npm.cmd' run browsers:install
  if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed.' }
} finally { Pop-Location }
