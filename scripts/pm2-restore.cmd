@echo off
setlocal

set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
cd /d "%ROOT_DIR%"

if not exist "%ROOT_DIR%\data\pm2" mkdir "%ROOT_DIR%\data\pm2"

if exist "%ROOT_DIR%\data\pm2\dump.pm2" (
  call "%ROOT_DIR%\scripts\pm2.cmd" resurrect
) else (
  call "%ROOT_DIR%\scripts\pm2.cmd" start ecosystem.config.cjs
  if errorlevel 1 exit /b 1
  call "%ROOT_DIR%\scripts\pm2.cmd" save
)

exit /b %errorlevel%
