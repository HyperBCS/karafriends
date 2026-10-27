# Changelog

## 0.2.0 (unreleased)

The product round: the phone remote, the display, settings and party-time failures. Each phase adds its line when it merges.

- A failed Joysound, YouTube or Niconico download now tells the phone that queued it why ("Couldn't download: Video unavailable"), the display shows it too, and the song can be queued again at once. Downloads that hang are stopped after 15 minutes.
- The display and the phone remote are dark now, with one accent color and larger type. The remote can be switched to Japanese (it picks the phone's language at first).
- Admins sign in on the phone with an admin password (`adminPasswordSalt` and `adminPasswordHash` in `config.yaml`) from a new profile page, and stay signed in across restarts. `adminDeviceIds` and `adminNicks` are gone; device IDs still decide whose song is whose.
- The app can now change its settings while it runs, test the DAM and Joysound logins, and export and import the whole config (logins included) for the coming settings screen. Changing a login takes effect at the next search; the port and proxy still need a restart.
- Admins can reorder the queue (`moveSong`: to the top, or to any place in it); the phone buttons for it come with the remote's refresh.
- The phone remote is rebuilt: one search box for DAM and Joysound (by title or artist, either catalog or both; a pasted YouTube or Niconico link opens the video), one song page, the queue in the now-playing sheet with Move to top, up and down for admins, and a profile screen for the nickname, language, notifications and admin sign-in. A new phone picks its nickname there first.
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
