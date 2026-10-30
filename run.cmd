@echo off
setlocal enableextensions
set "SCRIPT_DIR=%~dp0"

rem The host passes its own bundled runtime as VOICEOS_BUN (vendoredRuntime.ts),
rem so integrations start on machines with no bun or node installed at all.
set "BUN="
if defined VOICEOS_BUN if exist "%VOICEOS_BUN%" set "BUN=%VOICEOS_BUN%"
if not defined BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if not defined BUN for /f "delims=" %%i in ('where bun 2^>nul') do if not defined BUN set "BUN=%%i"

if not exist "%SCRIPT_DIR%node_modules" (
  pushd "%SCRIPT_DIR%"
  if defined BUN (
    "%BUN%" install 1>&2 || call npm install 1>&2
  ) else (
    call npm install 1>&2
  )
  popd
)

rem Bun executes TypeScript natively — the fast path.
if defined BUN (
  "%BUN%" "%SCRIPT_DIR%server.ts" %*
  exit /b
)

rem Node path: tsx is a declared dependency, so it's local after install.
if exist "%SCRIPT_DIR%node_modules\.bin\tsx.cmd" (
  call "%SCRIPT_DIR%node_modules\.bin\tsx.cmd" "%SCRIPT_DIR%server.ts" %*
  exit /b
)
call npx --yes tsx "%SCRIPT_DIR%server.ts" %*
exit /b
