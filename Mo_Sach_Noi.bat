@echo off
REM ============================================================
REM  Mo_Sach_Noi.bat
REM  Khoi dong ung dung Sach Noi EPUB (Piper TTS / Nghi-TTS)
REM  Server chay AN HOAN TOAN o nen (khong hien cua so, khong co
REM  trong taskbar). Log server duoc ghi vao file server.log de
REM  xem khi can debug. Cua so nay (launcher) se tu dong dong lai
REM  sau vai giay, khong can ban tu tay dong.
REM ============================================================
title Dang khoi dong Sach Noi EPUB...
setlocal
cd /d "%~dp0"

set "APP_PORT=3000"
set "APP_URL=http://localhost:%APP_PORT%"

echo Dang khoi dong Sach Noi EPUB, vui long doi...
echo (Cua so nay se tu dong dong sau vai giay)
echo.

REM -- Buoc 1: Kiem tra ung dung da duoc build chua ------------------------
if not exist "dist\index.html" (
    echo [LOI] Chua tim thay dist\index.html.
    echo Vui long chay start.bat mot lan de cai dat/build truoc.
    pause
    exit /b 1
)

REM -- Buoc 2: Dong phien server cu (neu con dang chay) --------------------
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tts_server.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

REM -- Buoc 3: Mo cong firewall (chi lan dau, can quyen Admin) --------------
netsh advfirewall firewall show rule name="Sach Noi EPUB" >nul 2>nul
if errorlevel 1 (
    netsh advfirewall firewall add rule name="Sach Noi EPUB" dir=in action=allow protocol=TCP localport=%APP_PORT% >nul 2>nul
)

REM -- Buoc 4: Khoi dong server AN HOAN TOAN (lang nghe ca LAN), log ra server.log --
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c python tts_server.py --host 0.0.0.0 --port %APP_PORT% > server.log 2>&1' -WindowStyle Hidden -WorkingDirectory '%~dp0'"

REM -- Buoc 5: Doi server khoi dong xong ------------------------------------
timeout /t 3 /nobreak >nul

REM -- Buoc 6: Hien thi dia chi IP LAN de dung tren thiet bi khac -----------
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "LAN_IP=%%a"
    goto :got_ip
)
:got_ip
set "LAN_IP=%LAN_IP: =%"
echo.
echo Truy cap tu thiet bi khac cung mang WiFi/LAN tai:
echo    http://%LAN_IP%:%APP_PORT%
echo.

REM -- Buoc 7: Mo trinh duyet mac dinh toi ung dung (ca 2 trang) -------------
start "" "%APP_URL%"
timeout /t 1 /nobreak >nul

REM -- Buoc 8: Tu dong dong cua so nay (doi lau hon de doc dia chi LAN) -----
echo Cua so nay se tu dong dong sau 10 giay...
timeout /t 10 /nobreak >nul
exit
