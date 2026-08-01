@echo off
setlocal

rem Always resolve the Three.js app relative to this script.
set "APP_DIR=%~dp0threejs"

if not exist "%APP_DIR%\package.json" (
  echo [ERROR] Cannot find "%APP_DIR%\package.json".
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js and try again.
  exit /b 1
)

pushd "%APP_DIR%"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    popd
    exit /b 1
  )
)

echo Starting the Three.js development server at http://127.0.0.1:4173/ ...
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
