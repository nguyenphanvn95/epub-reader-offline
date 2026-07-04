@echo off
setlocal enabledelayedexpansion
title Build SachNoiEPUB.exe
cd /d "%~dp0"

echo ================================================================
echo   DONG GOI SACH NOI EPUB THANH FILE .EXE (desktop, khong browser)
echo ================================================================
echo.

REM -- 1. Kiem tra Python --------------------------------------------------
where python >nul 2>nul
if errorlevel 1 (
    echo [LOI] Khong tim thay Python.
    echo Cai Python 3.9-3.12 tai: https://www.python.org/downloads/
    echo Nho tick "Add Python to PATH" khi cai.
    pause
    exit /b 1
)
echo [OK] Da tim thay Python.
python --version

REM -- 2. Kiem tra Node.js (can de build giao dien React) ------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [LOI] Khong tim thay Node.js. Can Node.js de build giao dien.
    echo Cai tai: https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Da tim thay Node.js.
node --version

echo.
echo ------------------------------------------------------------
echo   Buoc 1/5: Cai thu vien Python (Flask, Piper TTS, pywebview...)
echo ------------------------------------------------------------
python -m pip install --quiet --disable-pip-version-check --upgrade pip
python -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo [LOI] Cai thu vien Python that bai. Kiem tra ket noi mang.
    pause
    exit /b 1
)
python -m pip install --quiet --disable-pip-version-check pyinstaller
if errorlevel 1 (
    echo [LOI] Cai PyInstaller that bai.
    pause
    exit /b 1
)
echo [OK] Xong.

echo.
echo ------------------------------------------------------------
echo   Buoc 2/5: Build giao dien React (dist/)
echo ------------------------------------------------------------
if not exist "node_modules\@breezystack\lamejs" (
    echo Dang cai thu vien npm - thieu goi moi, lan dau co the mat vai phut...
    call npm install
    if errorlevel 1 (
        echo [LOI] npm install that bai.
        pause
        exit /b 1
    )
)
call npm run build
if errorlevel 1 (
    echo [LOI] Build giao dien that bai.
    pause
    exit /b 1
)
echo [OK] Da build xong giao dien vao thu muc dist\

echo.
echo ------------------------------------------------------------
echo   Buoc 3/5: Tai san giong doc mac dinh (de nguoi dung khong
echo             phai doi tai model o lan chay dau tien)
echo ------------------------------------------------------------
python tts_server.py --download vais1000-medium
if errorlevel 1 (
    echo [CANH BAO] Tai giong doc that bai - co the do mang. Se bo qua -
    echo             file .exe van chay duoc, chi la se tu tai giong o
    echo             lan mo dau tien - can internet luc do.
)

echo.
echo ------------------------------------------------------------
echo   Buoc 4/5: Don dep ban build cu (neu co)
echo ------------------------------------------------------------
if exist "build" rmdir /s /q "build"
if exist "dist_exe" rmdir /s /q "dist_exe"
if exist "SachNoiEPUB.spec" del /q "SachNoiEPUB.spec"

echo.
echo ------------------------------------------------------------
echo   Buoc 5/5: Dong goi thanh file .exe bang PyInstaller
echo ------------------------------------------------------------
python -m PyInstaller --noconfirm --onefile --windowed ^
  --name "SachNoiEPUB" ^
  --icon "app_icon.ico" ^
  --distpath "dist_exe" ^
  --add-data "dist;dist" ^
  --collect-all piper ^
  --collect-all onnxruntime ^
  --collect-all phonemizer ^
  --collect-all espeakng_loader ^
  --collect-all gdown ^
  --hidden-import=webview.platforms.edgechromium ^
  --hidden-import=webview.platforms.winforms ^
  desktop_app.py

if errorlevel 1 (
    echo.
    echo [LOI] Dong goi that bai. Xem chi tiet loi phia tren.
    echo Meo: neu loi lien quan "No module named ...", them dong
    echo      "--collect-all ten_module_do" vao lenh PyInstaller o tren
    echo      trong file build_exe.bat roi chay lai.
    pause
    exit /b 1
)

echo.
echo ================================================================
echo   HOAN TAT!
echo   File .exe nam tai:  dist_exe\SachNoiEPUB.exe
echo.
echo   - Copy file SachNoiEPUB.exe ra ngoai (vd: Desktop) va chay
echo     truc tiep, khong can Python/Node, khong can mo trinh duyet.
echo   - Lan chay dau tien, exe se tu tao thu muc "voices" CANH file
echo     .exe do de luu giong doc da tai (giu nguyen giua cac lan
echo     chay). Neu chua co giong (buoc 3 that bai vi mang), lan dau
echo     mo exe can internet de tu tai giong mac dinh (~50MB).
echo   - Neu muon dem theo may khac, copy CA file .exe LAN thu muc
echo     "voices" (neu da co) de khoi phai tai lai giong doc.
echo ================================================================
pause
