@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/install.ps1'))"
