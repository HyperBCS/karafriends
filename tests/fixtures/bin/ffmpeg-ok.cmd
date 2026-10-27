@echo off
rem A stand-in for ffmpeg that "converts" at once: it prints ffmpeg's duration
rem and progress lines, creates the (empty) file named by its last argument
rem and exits 0. src/main/downloads/jobs.test.ts runs it as ffmpeg.
echo   Duration: 00:00:02.00, start: 0.000000, bitrate: 1000 kb/s 1>&2
echo frame=   30 fps=0.0 q=-1.0 size=       0KiB time=00:00:01.00 bitrate=N/A speed=N/A 1>&2
echo frame=   60 fps=0.0 q=-1.0 Lsize=       1KiB time=00:00:02.00 bitrate=N/A speed=N/A 1>&2
:next
if "%~2"=="" goto last
shift
goto next
:last
type nul > "%~1"
exit /b 0
