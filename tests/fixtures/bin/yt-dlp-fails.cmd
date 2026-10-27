@echo off
rem A stand-in for yt-dlp that fails the way it does for a removed video.
rem tests/e2e/downloadFailure.spec.ts points KARAFRIENDS_YTDLP_PATH here.
echo ERROR: [youtube] fixture: Video unavailable. This video is no longer available 1>&2
exit /b 1
