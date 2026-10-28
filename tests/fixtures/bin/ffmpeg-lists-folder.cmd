@echo off
rem Like ffmpeg-ok, but first it adds its output's name and what its folder
rem holds to listing.txt there, so src/main/downloads/jobs.test.ts can see
rem what a download leaves at each step.
rem shift moves %0 too, so keep the folder first.
set "here=%~dp0"
set "last="
:next
if "%~1"=="" goto done
set "last=%~1"
shift
goto next
:done
for %%F in ("%last%") do set "folder=%%~dpF"
echo --- %last%>> "%folder%listing.txt"
dir /b "%folder%" >> "%folder%listing.txt"
rem %* isn't moved by shift.
call "%here%ffmpeg-ok.cmd" %*
