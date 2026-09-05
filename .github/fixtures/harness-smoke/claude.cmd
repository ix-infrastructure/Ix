@echo off
rem Windows twin of the `claude` fixture: a shebang script cannot be spawned
rem by CreateProcess, so on Windows the fake CLI is a .cmd shim that answers
rem the host's `mcp list` probe exactly like the POSIX fixture. Kept ASCII:
rem cmd and CP1252 consoles mangle anything else.
if "%~1"=="mcp" if "%~2"=="list" (
  echo configured servers:
  exit /b 0
)
echo unsupported fixture invocation 1>&2
exit /b 2