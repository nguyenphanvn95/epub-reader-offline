@echo off
REM ============================================================
REM  Dung_Sach_Noi.bat
REM  Dung server dang chay an o nen (neu co).
REM ============================================================
title Dung Sach Noi EPUB

powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*tts_server.py*' }; if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Host 'Da dung server thanh cong.' } else { Write-Host 'Khong tim thay server nao dang chay.' }"

echo.
pause
