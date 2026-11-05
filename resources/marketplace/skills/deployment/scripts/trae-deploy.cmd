@echo off
setlocal

if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" goto x64
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto x64

echo {"ok":false,"error":{"code":"UNSUPPORTED_PLATFORM","message":"trae-deploy is not available for this platform","retryable":false,"details":{}},"request_id":null}
exit /b 2

:x64
set "BINARY=%~dp0..\bin\win32-x64\trae-deploy.exe"
if not exist "%BINARY%" (
  echo {"ok":false,"error":{"code":"CLI_BINARY_MISSING","message":"trae-deploy binary is missing from the plugin package","retryable":false,"details":{}},"request_id":null}
  exit /b 2
)

"%BINARY%" %*
exit /b %ERRORLEVEL%
