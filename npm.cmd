@echo off
setlocal
for /d %%D in ("%~dp0.tools\node-v24*-win-x64") do set "nodeDirectory=%%~fD"
if not defined nodeDirectory (
  echo Workspace Node.js runtime is missing. See README.md.
  exit /b 1
)
set "PATH=%nodeDirectory%;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.tools\browsers"
pushd "%~dp0"
"%nodeDirectory%\node.exe" "%nodeDirectory%\node_modules\npm\bin\npm-cli.js" %*
set "result=%errorlevel%"
popd
exit /b %result%
