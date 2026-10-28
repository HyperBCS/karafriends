# Changelog

## 0.2.0 (unreleased)

The product round: the phone remote, the display, settings and party-time failures. Each phase adds its line when it merges.

- A failed Joysound, YouTube or Niconico download now tells the phone that queued it why ("Couldn't download: Video unavailable"), the display shows it too, and the song can be queued again at once. Downloads that hang are stopped after 15 minutes.
- The display and the phone remote are dark now, with one accent color and larger type. The remote can be switched to Japanese (it picks the phone's language at first).
- Admins sign in on the phone with an admin password (`adminPasswordSalt` and `adminPasswordHash` in `config.yaml`) from a new profile page, and stay signed in across restarts. `adminDeviceIds` and `adminNicks` are gone; device IDs still decide whose song is whose.
- The app can now change its settings while it runs, test the DAM and Joysound logins, and export and import the whole config (logins included) for the coming settings screen. Changing a login takes effect at the next search; the port and proxy still need a restart.
- Admins can reorder the queue (`moveSong`: to the top, or to any place in it); the phone buttons for it come with the remote's refresh.
- A song queued while nothing plays starts at once instead of up to 5 seconds later. The app knows its ffmpeg and yt-dlp versions, can download them again on request, and notices when YouTube downloads fail because of yt-dlp rather than the video, for the coming settings screen; `KARAFRIENDS_YTDLP_PATH` and `KARAFRIENDS_FFMPEG_PATH` point it at your own copies.
- A Joysound download that fails halfway now also stops its other half (the YouTube background or the Joysound video) and cleans up after both; the downloader has unit tests with fake ffmpeg and yt-dlp.
- The display has a full-screen idle screen with a large QR code and what's up next, says in a corner which song starts, is queued or fails, shows the queue as a strip under the video (`Q`), and has a settings screen (`S`, or the gear) for the logins with Test login, the admin password, the queue rules, port and proxy, the QR code's address, microphones, Update tools, and Export and Import config. It opens by itself on a first launch.
- A song the display can't play (a missing or broken file, or a DAM stream that stops for good) is skipped with a "Couldn't play" note instead of freezing the queue, and a passing hiccup in a DAM stream no longer skips songs.
- The phone remote is rebuilt: one search box for DAM and Joysound (by title or artist, either catalog or both; a pasted YouTube or Niconico link opens the video), one song page, the queue in the now-playing sheet with Move to top, up and down for admins, and a profile screen for the nickname, language, notifications and admin sign-in. A new phone picks its nickname there first.
- Fixes from the review: songs are no longer dropped or deleted when two phones pick the same one (the second hears "Someone is already adding this song", one failed Joysound background no longer deletes another, and a DAM song no longer downloads twice into one file), nor queued half-written after a crash; a failed Update tools no longer fails the downloads waiting on it; at most two YouTube or Niconico downloads run at once, and a stopped one stops for good; live, upcoming and paid videos say so instead of blaming the tools; with no admin password set, phones hear that instead of "Wrong password"; importing an old `config.yaml` reads its `YOUR_PASSWORD_HERE` as empty and says when phones must sign in again; a `config.yaml` that isn't settings is kept as `config.yaml.broken`, and the logs never print a line of it.
- Remote fixes: Back keeps working after picking a Joysound background video, Back from the lyrics screen no longer returns to it while the song plays, a hand-typed YouTube or Niconico ID opens on Enter instead of mid-typing, the playback controls fit 320px phones, and the profile screen says when the host set no admin password.
- Cleanup: removed upstream's unused Cloudflare tunnel and DAM decryptor files and the `offkai.karafriends.party` hostname choice; faster CI builds.
- Settings has "Everyone is an admin" (`everyoneIsAdmin` in `config.yaml`) for parties: every phone gets the admin controls at once, with no password, and the per-phone song limit still applies.
- The phone remote holds still on iPhones: only the list in the middle and the queue in the now-playing sheet scroll, and the top bar, the sheet and the page no longer move or bounce. A Home button next to the profile button goes back to the search from any screen, and lists, the queue and the sheet now stand out from the background, with visible lines and more room between rows.
- Search results from DAM and Joysound come in one list, best match first, instead of all of DAM's and then all of Joysound's: an exact title before one that starts with the words, before one that contains them, and shorter titles first. Kana, kanji, romaji and full-width queries match DAM's readings too ("koi" finds 恋). Artist searches are ranked the same way.
- Admins reorder the queue on the phone by dragging a song's grip (or with the arrow keys on it) instead of the up and down buttons; Move to top stays.
- Admins can turn up Joysound's guide melody, which was never heard before (`setGuideMelodyLevel`, 0 to 1, muted by default and kept across songs and restarts).
- A Joysound song's lyrics show on the TV with kana over the kanji, in romaji, or both (romaji under the kanji line), picked on its page when queueing, with the phone's default on the profile screen ("Lyrics on the TV"); the romaji queue button is gone. Admins set the guide melody with a slider in the playback controls while a Joysound song plays.
- A "Readings" choice on the phone's profile shows song titles and artists with the kana reading DAM gives, in romaji, or both, under the title and after the artist, in search results, the queue and the history (Joysound gives no readings, so its songs show as written).

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
- Niconico lookups use yt-dlp (at most two lookups run at once), and a YouTube song's typed-in lyrics stay with it while it's queued.
- The phone remote works on older iPhones (Safari 15 and later), and the display and remote load faster with lighter styling.
