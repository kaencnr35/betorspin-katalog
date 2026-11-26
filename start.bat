@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM Düzenleme şifresi istersen aşağıdaki satırın başındaki REM'i kaldır ve PIN'i değiştir:
REM set EDIT_PIN=1234
node server.js
pause
