# Changelog

## 0.2.0 (unreleased)

The product round: the phone remote, the display, settings and party-time failures. Each phase adds its line when it merges.

- A failed Joysound, YouTube or Niconico download now tells the phone that queued it why ("Couldn't download: Video unavailable"), the display shows it too, and the song can be queued again at once. Downloads that hang are stopped after 15 minutes.
- The display and the phone remote are dark now, with one accent color and larger type. The remote can be switched to Japanese (it picks the phone's language at first).
- Cleanup: removed upstream's unused Cloudflare tunnel and DAM decryptor files and the `offkai.karafriends.party` hostname choice; faster CI builds.

## 0.1.0

The hard fork: karafriends stops following emmaworley/karafriends and gets simpler underneath. Parties work as before.

- karafriends is now its own project at [HyperBCS/karafriends](https://github.com/HyperBCS/karafriends), with Windows, macOS (Apple Silicon and Intel) and Linux zips on its Releases page.
- The repository is about 60 MB instead of 2.4 GB, and the app bundle is smaller.
- The app no longer sends crash reports or telemetry anywhere (Sentry and OpenTelemetry are gone).
- Phones and the display get the queue, now playing, playback and download progress the moment they change, instead of checking every few seconds.
- The display keeps working when the phones' port (8080) is taken by another program, and shows a banner saying phones can't connect.
- Admin rights are checked by the app, not by the phone. Admins are listed by device ID; a nickname no longer makes someone an admin.
- Phones no longer see other phones' device IDs; each phone just knows which songs are its own.
- The saved queue (`queue.json`) has a new format. Queues saved by older versions still load.
- A slow or silent DAM or Joysound server no longer holds up or drops the next song, and DAM results page correctly past the first page.
- Song IDs from phones are checked, so a bad one can't touch files outside the app's temp folder.
- Niconico lookups use yt-dlp, at most two YouTube or Niconico downloads run at once, and a YouTube song's typed-in lyrics stay with it while it's queued.
- The phone remote works on older iPhones (Safari 15 and later), and the display and remote load faster with lighter styling.
