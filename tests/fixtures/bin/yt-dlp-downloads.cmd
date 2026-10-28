@echo off
rem A stand-in for yt-dlp that "downloads" at once: it prints yt-dlp's
rem progress lines, creates the (empty) file named after -o and exits 0.
rem tests/e2e/player.spec.ts points KARAFRIENDS_YTDLP_PATH here, and
rem src/main/downloads/jobs.test.ts runs it as yt-dlp.
rem
rem Like the real one, it needs --ffmpeg-location to merge a video with its
rem audio (the app's ffmpeg isn't on PATH). Without it, it warns, leaves the
rem two parts and no file, and still exits 0.
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
type nul > "%output%"
goto progress
:unmerged
echo WARNING: You have requested merging of multiple formats but ffmpeg is not installed. The formats won't be merged 1>&2
type nul > "%output:.mp4=.f1.mp4%"
type nul > "%output:.mp4=.f2.mp4%"
:progress
echo [download] 100.0%% of    1.00MiB at    1.00MiB/s ETA 00:00
echo [download] 100%% of    1.00MiB in 00:00:00 at    1.00MiB/s
exit /b 0
