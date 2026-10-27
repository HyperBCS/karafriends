@echo off
rem A stand-in for yt-dlp that "downloads" at once: it prints yt-dlp's
rem progress lines, creates the (empty) file named after -o and exits 0.
rem tests/e2e/player.spec.ts points KARAFRIENDS_YTDLP_PATH here, and
rem src/main/downloads/jobs.test.ts runs it as yt-dlp.
:next
if "%~1"=="" goto done
if "%~1"=="-o" echo [download] Destination: %~2
if "%~1"=="-o" type nul > "%~2"
shift
goto next
:done
echo [download] 100.0%% of    1.00MiB at    1.00MiB/s ETA 00:00
echo [download] 100%% of    1.00MiB in 00:00:00 at    1.00MiB/s
exit /b 0
