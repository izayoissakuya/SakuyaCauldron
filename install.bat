@echo off
cd /d "%~dp0"
echo Sakuya Cauldron - ilk kurulum
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo .env dosyasi olusturuldu. Once bu dosyaya Twitch bilgilerini yazmalisin.
)
echo.
node --version
if errorlevel 1 (
  echo Node.js bulunamadi. Node.js 22 LTS yukle: https://nodejs.org/
  pause
  exit /b 1
)
echo Bagimliliklar yukleniyor...
call npm install
if errorlevel 1 (
  echo Kurulum sirasinda hata olustu.
  pause
  exit /b 1
)
echo.
echo Kurulum tamamlandi. README_TR.md dosyasini oku, .env dosyasini doldur.
pause
