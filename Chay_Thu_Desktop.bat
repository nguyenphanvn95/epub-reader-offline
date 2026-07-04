@echo off
setlocal
title Sach Noi EPUB (che do desktop - chay thu)
cd /d "%~dp0"

echo ================================================================
echo   CHAY THU CHE DO DESKTOP (khong build .exe, chi de kiem tra)
echo ================================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [LOI] Khong tim thay Python. Cai tai python.org
    pause
    exit /b 1
)

echo Dang cai/kiem tra thu vien can thiet...
python -m pip install --quiet --disable-pip-version-check -r requirements.txt

if not exist "dist\index.html" (
    echo.
    echo [CANH BAO] Chua build giao dien. Dang build...
    where node >nul 2>nul
    if errorlevel 1 (
        echo [LOI] Can Node.js de build giao dien. Cai tai nodejs.org
        pause
        exit /b 1
    )
    if not exist "node_modules\@breezystack\lamejs" call npm install
    call npm run build
)

echo.
echo Dang mo cua so ung dung...
python desktop_app.py

pause
