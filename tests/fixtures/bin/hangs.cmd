@echo off
rem A stand-in for a tool that hangs in a process it started, as yt-dlp does
rem under its .cmd wrapper. src/main/downloads/run.test.ts runs it: ping
rem keeps the output open, so the run only ends once ping is stopped too.
ping -n 60 127.0.0.1
