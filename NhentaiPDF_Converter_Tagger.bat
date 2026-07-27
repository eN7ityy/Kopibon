@echo off
cd /d "%~dp0"

IF EXIST ".venv\Scripts\pythonw.exe" (
    :: 'start' launches the app and immediately closes this batch window
    :: 'pythonw.exe' runs the script without creating a new console window
    start "" ".venv\Scripts\pythonw.exe" "NhentaiPDF_Converter_Tagger.py"
) ELSE (
    echo ERROR: Could not find the .venv folder.
    echo Please run Setup_Dependencies.bat first!
    pause
)