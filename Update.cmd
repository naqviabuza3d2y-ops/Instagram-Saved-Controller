@echo off
setlocal DisableDelayedExpansion
rem Update.ps1 selects git pull --ff-only for Git checkouts, or the ZIP updater.
rem Read this entire block before the updater can replace Update.cmd itself.
(
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update.ps1"
  if errorlevel 1 (
    echo.
    echo Update failed. Read the error above before reloading the extension.
    pause
    exit /b 1
  ) else (
    echo.
    pause
    exit /b 0
  )
)
