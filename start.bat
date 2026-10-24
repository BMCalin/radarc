@echo off
chcp 65001 >nul
title RadArc
cd /d "%~dp0"
python --version >nul 2>&1 || (echo Python is not installed or not on PATH. & pause & exit /b 1)
python -m pip install --quiet --disable-pip-version-check psutil maxminddb
python server.py %*
pause
