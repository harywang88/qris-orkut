@echo off
setlocal

set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"
set "PM2_HOME=%ROOT_DIR%\data\pm2"

cd /d "%ROOT_DIR%"
pm2 %*

exit /b %errorlevel%
