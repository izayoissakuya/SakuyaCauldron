@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Once install.bat dosyasini calistir.
  pause
  exit /b 1
)
call npm start
pause
