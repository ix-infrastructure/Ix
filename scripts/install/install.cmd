@echo off
@REM Copyright 2026 Ix Infrastructure Inc.

powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ((New-Object System.Net.WebClient).DownloadString('https://ix-infra.com/install.ps1'))"
