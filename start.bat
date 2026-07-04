@echo off
setlocal enabledelayedexpansion
title Sach Noi EPUB - Piper TTS + Nghi-TTS
cd /d "%~dp0"

echo ============================================================
echo   SACH NOI EPUB - Piper TTS + Nghi-TTS (CPU Offline)
echo ============================================================
echo.

REM -- 1. Kiem tra Python --------------------------------------------
where python >nul 2>nul
if errorlevel 1 goto :no_python
echo [OK] Da tim thay Python.
python --version
goto :check_node

:no_python
echo [LOI] Khong tim thay Python.
echo Vui long cai Python 3.9+ tai: https://www.python.org/downloads/
echo Nho tick chon "Add Python to PATH" khi cai dat.
pause
exit /b 1

:check_node
REM -- 2. Kiem tra Node.js (chi can khi build frontend lan dau) ------
set NODE_MISSING=0
where node >nul 2>nul
if errorlevel 1 set NODE_MISSING=1
if "%NODE_MISSING%"=="1" (
    echo [CANH BAO] Khong tim thay Node.js.
    echo Neu thu muc dist chua ton tai, ban can cai Node.js tai nodejs.org
) else (
    echo [OK] Da tim thay Node.js.
    node --version
)

echo.
echo ------------------------------------------------------------
echo   Buoc 1/5: Cai dat thu vien Python - Flask + Piper TTS
echo ------------------------------------------------------------
python -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo [LOI] Cai dat thu vien Python that bai. Kiem tra ket noi mang.
    pause
    exit /b 1
)
echo [OK] Da cai dat xong thu vien Python co ban.

echo.
echo ------------------------------------------------------------
echo   Buoc 2/5: Tai Piper model tieng Viet neu chua co
echo ------------------------------------------------------------
if not exist "voices" mkdir voices
python tts_server.py --download vais1000-medium
if errorlevel 1 (
    echo [CANH BAO] Tai Piper model that bai. Se thu lai khi server khoi dong.
)

echo.
echo ------------------------------------------------------------
echo   Buoc 3/5: Kiem tra model Nghi-TTS (tuy chon)
echo ------------------------------------------------------------
dir /b "voices\nghitts\*.onnx" >nul 2>nul
if errorlevel 1 (
    echo [INFO] Chua co model Nghi-TTS nao trong voices\nghitts\
    echo        De tai model - xem github.com/nghimestudio/nghitts - chay lenh sau trong terminal:
    echo        python tts_server.py --download-nghitts
    echo        Hoac tai thu cong va copy file .onnx + .onnx.json vao thu muc voices\nghitts\
) else (
    echo [OK] Da tim thay model Nghi-TTS trong voices\nghitts\
)

echo.
echo ------------------------------------------------------------
echo   Buoc 4/5: Build giao dien web - React
echo ------------------------------------------------------------

if exist "dist\index.html" goto :skip_build
if "%NODE_MISSING%"=="1" goto :need_node

if exist "node_modules\@breezystack\lamejs" goto :do_build
echo Dang cai dat thu vien npm (thieu goi moi), lan dau co the mat vai phut...
call npm install
if errorlevel 1 goto :npm_install_failed

:do_build
echo Dang build giao dien...
call npm run build
if errorlevel 1 goto :npm_build_failed
echo [OK] Build giao dien thanh cong.
goto :after_build

:need_node
echo [LOI] Can Node.js de build giao dien lan dau.
echo Vui long cai Node.js tai nodejs.org roi chay lai start.bat
pause
exit /b 1

:npm_install_failed
echo [LOI] npm install that bai.
pause
exit /b 1

:npm_build_failed
echo [LOI] Build giao dien that bai.
pause
exit /b 1

:skip_build
echo [OK] Giao dien da duoc build truoc do. Bo qua buoc build.
echo      Xoa thu muc dist neu muon build lai.

:after_build
echo.
echo ------------------------------------------------------------
echo   Buoc 5/5: Khoi dong server tai localhost:3000
echo ------------------------------------------------------------
echo.
echo   Mo trinh duyet:  http://localhost:3000
echo   Nhan Ctrl+C de dung server.
echo.
echo ============================================================
echo.

start "" "http://localhost:3000"
timeout /t 1 /nobreak >nul
python tts_server.py --port 3000

pause
