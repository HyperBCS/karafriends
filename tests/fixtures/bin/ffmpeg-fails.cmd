@echo off
rem A stand-in for ffmpeg that fails the way it does on input it can't read.
rem src/main/downloads/jobs.test.ts runs it as ffmpeg.
echo [in#1 @ 0000000000000000] Error opening input: Invalid data found when processing input 1>&2
echo Error opening input file -. 1>&2
exit /b 1
