@echo off
rem A stand-in for yt-dlp that fails the way an outdated one does on YouTube:
rem its bot check. tests/e2e/downloadFailure.spec.ts points KARAFRIENDS_YTDLP_PATH here.
echo ERROR: [youtube] fixture: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. 1>&2
exit /b 1
