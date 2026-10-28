# M8 spike: can the guide vocal be mixed at a chosen volume?

Done 2026-10-27 on a Japanese IP (`curl -s https://ipinfo.io/country` → `JP`) with the installed app's DAM and Joysound logins, the app's own API classes (`MinseiAPI`, `DkwebsysAPI`, `JoysoundAPI`) run under `node --import tsx`, and the app's ffmpeg (`%APPDATA%\karafriends\externalResources\ffmpeg\ffmpeg.exe`; there is no ffprobe, so `ffmpeg -i` listed the streams). Songs: 米津玄師「Lemon」 and YOASOBI「夜に駆ける」 on both services. The scratch scripts were in `build/spike/` (gitignored) and aren't committed. Stream tokens in URLs are shown as `<token>`.

## Answer

| Service  | What the "guide" is                                                                                                                                                           | Volume control possible?                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| DAM      | A **separate full mix**. Each vocal type is its own HLS stream with one stereo AAC track, with the guide vocal baked in and centred (on both channels, not one).              | **No.** You can only pick a mix.        |
| Joysound | A **separate channel**. The song's ogg is 3-channel Vorbis (L, R, C), and C is a synthesised guide _melody_, not a sung vocal. Today the display drops C, so nobody hears it. | **Yes.** It's the guide melody's level. |

## DAM

### What `getMusicStreamingUrls` returns

You get one entry per vocal type in the details info's `guideVocal`, in the same order. Each entry has its own `contentsId`, and its `duet` field names the vocal type. Each entry carries a high-bitrate URL (720p) and a low-bitrate URL (540p).

```
Lemon 3246-51: guideVocal "0,1"   (0 = NORMAL, 1 = GUIDE_MALE, 2 = GUIDE_FEMALE)
status 0000 data {"karaokeContentsId":"5716836"}
keys of list[0] [ 'contentsId', 'duet', 'highBitrateUrl', 'lowBitrateUrl' ]
0 {"contentsId":"5719249","duet":"normal","highBitrateUrl":"https://cds1-clubdam.k56.ipcasting.jp/<token>/3246-51sk_1.mp4.m3u8","lowBitrateUrl":"https://cds1-clubdam.k56.ipcasting.jp/<token>/3246-51sk_0.mp4.m3u8"}
1 {"contentsId":"5760541","duet":"male","highBitrateUrl":"https://cds1-clubdam.k56.ipcasting.jp/<token>/3246-51mk_1.mp4.m3u8","lowBitrateUrl":"https://cds1-clubdam.k56.ipcasting.jp/<token>/3246-51mk_0.mp4.m3u8"}

夜に駆ける 5267-20: guideVocal "0,2"
0 {"contentsId":"5839583","duet":"normal", ... 5267-20sk_1.mp4.m3u8 / 5267-20sk_0.mp4.m3u8}
1 {"contentsId":"5857432","duet":"female", ... 5267-20fk_1.mp4.m3u8 / 5267-20fk_0.mp4.m3u8}
```

The file names follow the vocal type: `sk` is plain, `mk` is the male guide and `fk` is the female guide. `_1` is the high bitrate and `_0` the low.

### The playlists

Each URL is already a media playlist. There's no master playlist, no `#EXT-X-MEDIA` alternate audio and no `#EXT-X-STREAM-INF`. The segments are AES-128 encrypted. The plain and guide playlists cut their segments differently (Lemon: 33 segments against 34, with different `EXTINF`s), so each is a separate encode.

```
=== [0] normal highBitrateUrl .../<token>/3246-51sk_1.mp4.m3u8 -> 200 application/vnd.apple.mpegurl
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="/<token>/common.bin",IV=0x…,KEYFORMATVERSIONS="1"
#EXTINF:8.008,
https://cds1-clubdam.k56.ipcasting.jp/ohls-cds1/karadam/1/324/3246-51sk_1.mp4/media_0.ts
…
#EXTINF:8.144,
…/3246-51sk_1.mp4/media_32.ts
#EXT-X-ENDLIST

=== [1] male highBitrateUrl .../<token>/3246-51mk_1.mp4.m3u8 -> 200 application/vnd.apple.mpegurl
#EXT-X-TARGETDURATION:9
#EXTINF:8.008,  …/3246-51mk_1.mp4/media_0.ts
#EXTINF:7.908,  …/3246-51mk_1.mp4/media_1.ts
…
#EXTINF:1.371,  …/3246-51mk_1.mp4/media_33.ts
#EXT-X-ENDLIST
```

### The streams

All eight variants (2 songs × 2 vocal types × 2 bitrates) have the same layout: one timed-ID3 data stream, one H.264 stream and **exactly one audio stream, stereo AAC at 48 kHz, with no language tag**.

```
=== [0] 3246-51-0-normal-high contentsId=5719249 (exit 0)
Input #0, hls, from 'https://cds1-clubdam.k56.ipcasting.jp/<token>/3246-51sk_1.mp4.m3u8':
  Duration: 00:04:25.30, start: 0.000000, bitrate: N/A
  Program 0
  Stream #0:0[0x0]: Data: timed_id3 (ID3  / 0x20334449)
  Stream #0:1[0x0]: Video: h264 (Constrained Baseline) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709), 1280x720 [SAR 1:1 DAR 16:9], 29.97 fps, 29.97 tbr, 90k tbn
  Stream #0:2[0x0]: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp

=== [1] 3246-51-1-male-high contentsId=5760541 (exit 0)
Input #0, hls, from 'https://cds1-clubdam.k56.ipcasting.jp/<token>/3246-51mk_1.mp4.m3u8':
  Duration: 00:04:25.30, start: 0.000000, bitrate: N/A
  Stream #0:0[0x0]: Data: timed_id3 (ID3  / 0x20334449)
  Stream #0:1[0x0]: Video: h264 (Constrained Baseline) …, 1280x720 …
  Stream #0:2[0x0]: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp

(the _0 variants: the same with 960x540 video; 夜に駆ける sk_1 and fk_1: the same, Duration 00:04:31.21)
```

### Is the guide vocal on one channel, and is the backing the same?

I decoded the first 90 s of the plain mix (A) and the guide mix (B) to WAV, aligned B against A by cross-correlation, and compared them. "res" is B − A after alignment.

```
Lemon (A = normal sk_1, B = male mk_1)
A: L -22.1 dBFS, R -22.5 dBFS, corr(L,R) 0.647, mid -23.2 dBFS, side -29.8 dBFS
B: L -20.5 dBFS, R -20.8 dBFS, corr(L,R) 0.760, mid -21.2 dBFS, side -29.9 dBFS
best lag of B against A: -189 samples (-3.94 ms)
aligned: corr(A.L,B.L) 0.577, corr(A.R,B.R) 0.589 | residual B-A: L -21.9 dBFS, R -22.3 dBFS, corr(resL,resR) 0.652
lp150 L: corr 0.900, gain 0.922 | bp1k-4k L: corr 0.298, gain 0.391   (R the same to 0.03)

夜に駆ける (A = normal sk_1, B = female fk_1)
A: L -19.4 dBFS, R -19.5 dBFS, corr(L,R) 0.871
B: L -18.7 dBFS, R -18.8 dBFS, corr(L,R) 0.893
best lag of B against A: -2397 samples (-49.94 ms)
aligned: corr(A.L,B.L) 0.772, corr(A.R,B.R) 0.774 | residual B-A: L -22.4 dBFS, R -22.5 dBFS, corr(resL,resR) 0.724
lp150 L: corr 0.960, gain 0.954 | bp1k-4k L: corr 0.327, gain 0.440
lp150 per 5 s window: corr 0.94–0.996 once the band is playing, lag -2371…-2400 samples
```

- **Not on one channel.** The guide mix is louder by the same amount on L and R. The residual (the guide vocal plus encoding differences) is equally loud on both sides, and the two sides correlate at 0.65–0.72, which is a centred voice with stereo reverb. In the plain mix, L and R are within 0.4 dB of each other. So a balance control can't isolate the guide.
- **The same backing, but not the same file.** Below 150 Hz the two mixes correlate at 0.90–0.996, so the backing is the same with a vocal on top. They don't cancel, though. In the voice band (1–4 kHz) the correlation is about 0.3. The offset between the two encodes also differs per song: 4 ms for Lemon, 50 ms for 夜に駆ける.
- One more thing showed up: a set of URLs from one `getMusicStreamingUrls` call stopped opening within minutes (`Error opening input: Invalid data found when processing input`), after one of them had been played. Fresh URLs from a new call worked every time. I didn't pin down whether that's a timeout or one playback per set.

### Verdict for DAM: **no**

There's no separate guide track, only two full mixes with the vocal baked in. The only way to get "a bit of guide" would be to play both mixes at once and crossfade between them. That would need two HLS players held in sample-accurate sync, with a different offset for every song (4 ms here, 50 ms there). It would download twice the data, and both URL sets would have to stay valid while they play. Because the two encodes don't cancel exactly, any sync error would cause comb filtering. I don't recommend it. Keep the two queue buttons as they are.

## Joysound

### `getSongDetail`, the song list, `getSongRawData`

- `getSongDetail` returns `{"name":"Lemon","artistName":"米津玄師","lyricsPreview":"夢ならばどれほどよかったでしょ","tieUp":"アンナチュラル"}`. None of its fields is about a guide.
- The search row (`getSongListByKeyword`) has `selSongNo`, `songName`, `artistName`, `serviceTypeList`, `outsideUrlInfo` (Amazon/iTunes) and `artistId_digi`. Again, nothing about a guide. Lemon 425691 and 夜に駆ける 446181 list two service types, `003000761` (the one the app uses) and `003000762`. The サビカラ versions list only `003000761`.
- `getFME` (`getSongRawData`) returns only `telop` and `ogg`: `raw keys [ 'telop: string 17304 chars', 'ogg: string 3979644 chars' ]`. The `slc` and `streaming_wifi_url` fields in `JoysoundSongRawData` aren't in the response. Both strings are base64 with the first 30 characters moved to the end, which is how `jobs.ts` decodes them.
- With `serviceType: "003000762"`, `getFME` returns a different arrangement (4:30.50 instead of 4:32.50) with the same 3.0 layout, and `contentsInfo` returns a different set of background movies. That's another version of the song, not a guide track.

### The ogg

It is **3-channel Vorbis**:

```
Input #0, ogg, from 'build/spike/out/joy-425691.ogg':
  Duration: 00:04:32.50, start: 0.000000, bitrate: 87 kb/s
  Stream #0:0: Audio: vorbis, 44100 Hz, 3.0, fltp, 94 kb/s
    Metadata:
      playtime        : 272500
ogg header strings [ 'vorbis', "AO; aoTuV [20110424] (based on Xiph.Org's libVorbis)", 'playtime=272500', … ]

夜に駆ける 446181:
  Duration: 00:04:32.78, start: 0.000000, bitrate: 96 kb/s
  Stream #0:0: Audio: vorbis, 44100 Hz, 3.0, fltp, 94 kb/s
      playtime        : 272778
```

It has one stream and no second audio stream. ffmpeg decodes it as FL, FR, FC. The first 90 s, per channel:

```
Lemon 425691              夜に駆ける 446181
level: FL -16.2, FR -16.0, FC -17.1 dBFS          FL -14.9, FR -14.6, FC -18.2 dBFS
corr(FL,FR) 0.772  corr(FL,FC) -0.003  corr(FR,FC) 0.003     corr(FL,FR) 0.748  corr(FL,FC) -0.000  corr(FR,FC) 0.002
window     FL     FR     FC                        window     FL     FR     FC
  5- 10s  -24.2  -21.5   -inf   (intro)             5- 10s  -34.0  -35.6   -inf   (intro)
 10- 15s  -30.5  -27.6  -27.9                      25- 30s  -15.1  -13.9  -26.9
 40- 45s  -12.9  -13.1  -16.5                      30- 35s  -12.0  -11.7   -inf   (interlude)
 70- 75s  -14.0  -13.8  -14.0                      35- 40s  -11.8  -11.2   -inf   (interlude)
```

FC is uncorrelated with the stereo backing and silent wherever nobody sings. A pitch track of FC (YIN-style, 46 ms frames) shows a synthesised melody, not a voice. It sits within 2 cents of an equal-tempered note and stays flat within notes. A singer drifts and uses vibrato:

```
channel 2 (FC), Lemon:      3028 of 3873 frames pitched (78%)
|cents from semitone|: median 1.8, 75% 2.8, 90% 3.9 (uniform would be 25/37.5/45)
within-note frame-to-frame change (cents): median 0.32, 90% 1.10
channel 2 (FC), 夜に駆ける: 2203 of 3874 frames pitched (57%)
|cents from semitone|: median 2.5, 75% 4.1, 90% 5.3
channel 0 (FL), Lemon, for comparison: 349 frames pitched (9%)
```

So Joysound's "guide" is the classic karaoke guide melody on its own centre channel. It isn't a guide vocal.

### The movie URLs

`getMovieUrls` (`/player/contentsInfo`) returns `{slc, movie: {mov1…mov5}}`, which are generic background videos from `cdn.sound-cafe.jp/backmovie/…`. They have **no audio at all**:

```
--- movie.mov1 https://cdn.sound-cafe.jp/backmovie/E/10E00167.mp4
  Duration: 00:04:30.07, start: 0.000000, bitrate: 502 kb/s
  Stream #0:0[0x1](und): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 501 kb/s, 29.97 fps, 29.97 tbr, 11988 tbn (default)
(mov2–mov5: the same, video only, 5:00.37)
```

### What the app does with the ogg today

`composeJoysoundVideoPromise` copies the ogg into the mp4 unchanged (`-c copy`). I reproduced that step:

```
Stream #0:1[0x2](und): Audio: vorbis (mp4a / 0x6134706D), 44100 Hz, 3.0, fltp, 27 kb/s (default)
```

So the display plays a 3-channel track. I played that mp4 through the display's graph (`createMediaElementSource` → gain → destination) in Chromium, using the Browser pane rather than the Electron app. A `ChannelSplitter` on the source and a 2-channel `explicit`/`speakers` gain node show what the destination mixes:

```
joy-audio.mp4 (audio) playing, ctx 44100 Hz, destination maxChannelCount 2, channelCount 2
  corr(ch0,ch1) 0.847, corr(ch0,ch2) -0.074, corr(ch1,ch2) -0.013
t=5.0s source channels (dBFS): -14.1 | -14.3 | -17.1 | -inf | -inf | -inf; destination-style mix L -14.1 R -14.3; mixL = [1.000, 0.000, 0.000]·[ch0,ch1,ch2], mixR = [0.000, 1.000, 0.000]
```

The source delivers L, R, C as channels 0, 1, 2. The stereo mix takes L and R and **drops C completely**: Web Audio has no speaker down-mix rule for 3 channels, so it falls back to discrete. The phase vocoder passes all 3 channels through unchanged, so the destination drops C there too. **So today the Joysound guide melody is never heard.**

### Verdict for Joysound: **yes**

The guide melody is a separate channel. Mixing it in at a chosen gain is plain Web Audio. Keep in mind that it's a melody line, not a vocal.

## The display: the smallest way to control the level

- **DAM:** nothing to do. The vocal type is chosen when the song is queued, and it stays that way.
- **Joysound:** add a `ChannelSplitter`/`ChannelMerger` pair to `src/renderer/webAudio.ts`. The media source feeds a `ChannelSplitter(3)`. Outputs 0 and 1 go straight to inputs 0 and 1 of a `ChannelMerger(2)`. Output 2 goes through a new guide `GainNode` into both merger inputs (about 0.7 each, so a centred channel keeps its level). The merger then feeds today's gain → vocoder chain, so the key change applies to the melody too.

  Only route through the splitter while a Joysound song plays. A splitter up-mixes discretely, so a mono source (a Nico video, say) would come out on the left only. DAM, YouTube and Nico keep today's direct path.

  Give `KarafriendsAudio` a fixed input node so `useSongPlayer` connects the media source once. Right now it connects to `audio.sink()`, which is the gain node or the vocoder depending on whether the worklet has loaded yet, and if it's the vocoder the main gain is skipped.

  The rest is as the plan's M8 describes: `guideVocalVolume` (0–1) in the live state, an admin-only `setGuideVocalVolume`, and a slider in the phone's playback controls next to the key. Show the slider only for Joysound songs, and call it "Guide melody".
  - Display: `src/renderer/webAudio.ts`, `src/renderer/useSongPlayer.ts` (connect to the input, switch the routing per song kind, apply the volume) and `src/renderer/Player.tsx`.
  - Server: `src/common/api.ts`, `src/main/api.ts`, `src/main/validate.ts`, `src/main/live.ts` and `src/main/state.ts`.
  - Phone: `src/common/hooks/` (a hook like `usePitchShiftSemis`), `src/remocon/components/NowPlayingSheet/PlaybackControls.tsx` and `src/remocon/i18n`.

  Pick the default with care. Leaving the melody muted keeps today's sound. Turning it up would change how every Joysound song sounds, even for people who never touch the slider.

  Before building, check the routing once in the Electron app, since the test above ran in the Browser pane's Chromium.
