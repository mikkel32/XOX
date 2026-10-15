@echo off
node "%~dp0build-extension.mjs" %*
exit /b %ERRORLEVEL%
