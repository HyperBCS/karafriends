@echo off
rem Like yt-dlp-downloads, but the file it "downloads" is a minute of black
rem video (tests/fixtures/black.mp4), so the display can play it.
rem tests/e2e/player.spec.ts points KARAFRIENDS_YTDLP_PATH here.
rem shift moves %0 too, so keep the folder first.
set "here=%~dp0"
:next
if "%~1"=="" goto done
if "%~1"=="-o" echo [download] Destination: %~2
if "%~1"=="-o" copy /y "%here%..\black.mp4" "%~2" >nul
shift
goto next
:done
echo [download] 100.0%% of    1.00MiB at    1.00MiB/s ETA 00:00
echo [download] 100%% of    1.00MiB in 00:00:00 at    1.00MiB/s
exit /b 0
