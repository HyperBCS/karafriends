@echo off
rem Like yt-dlp-downloads, but the file it "downloads" is a minute of black
rem video (tests/fixtures/black.mp4), so the display can play it.
rem tests/e2e/player.spec.ts points KARAFRIENDS_YTDLP_PATH here.
rem shift moves %0 too, so keep the folder first.
set "here=%~dp0"
set "output="
set "ffmpeg="
:next
if "%~1"=="" goto done
if "%~1"=="-o" set "output=%~2"
if "%~1"=="--ffmpeg-location" set "ffmpeg=%~2"
shift
goto next
:done
if not defined output goto progress
echo [download] Destination: %output%
if not defined ffmpeg goto unmerged
copy /y "%here%..\black.mp4" "%output%" >nul
goto progress
:unmerged
echo WARNING: You have requested merging of multiple formats but ffmpeg is not installed. The formats won't be merged 1>&2
type nul > "%output:.mp4=.f1.mp4%"
type nul > "%output:.mp4=.f2.mp4%"
:progress
echo [download] 100.0%% of    1.00MiB at    1.00MiB/s ETA 00:00
echo [download] 100%% of    1.00MiB in 00:00:00 at    1.00MiB/s
exit /b 0
