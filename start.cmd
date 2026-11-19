@echo off
cd /d "%~dp0"
echo Starting DetailQuote-US on http://127.0.0.1:8787
echo.
echo   Customer Demo (Apex Austin):  http://127.0.0.1:8787/s/apex-austin
echo   Customer Demo (Harbor Miami): http://127.0.0.1:8787/s/harbor-miami
echo   Owner Cabinet (PIN 2026):     http://127.0.0.1:8787/s/apex-austin/owner
echo   Agency Demo Hub:              http://127.0.0.1:8787/demos
echo.
python -X utf8 app.py
