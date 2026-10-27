@echo off
rem A stand-in for yt-dlp that "downloads" at once: it creates the (empty)
rem file named after -o and exits 0. tests/e2e/player.spec.ts points
rem KARAFRIENDS_YTDLP_PATH here.
:next
if "%~1"=="" exit /b 0
if "%~1"=="-o" type nul > "%~2"
shift
goto next
