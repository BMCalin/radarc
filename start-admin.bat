@echo off
:: Start RadArc as administrator (shows names of all processes, including system ones)
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0start.bat' -Verb RunAs -WorkingDirectory '%~dp0'"
