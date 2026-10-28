# Plan: UI round (2026-10-28)

The user listed ten UI changes and fixes after the mic test. Same way of working as before: one coordinating session, each phase an Opus subagent in its own worktree, branched from master `34e7608` (which holds the previous round's Settings wording, Song output, mic level meters and QR corner). The coordinator reviews, re-runs checks and merges. "Keep it simple" and the design brief in [`PLAN-product.md`](PLAN-product.md) bind every phase. Nothing plays sound or steals focus on this computer (hidden app, `KARAFRIENDS_HIDE_WINDOW=1`, `KARAFRIENDS_LOCAL_ONLY=1`).

## Status (keep this table current)

| Phase                                 | State   | Branch / commit | Notes |
| ------------------------------------- | ------- | --------------- | ----- |
| U1: song progress and countdowns      | running |                 |       |
| U2: TV Settings in tabs, pitch bars   | running |                 |       |
| U3: phone sheet: layers, now playing  | running |                 |       |
| U4: phone search bar and settings     | running |                 |       |
| U5: TV up next initials, long names   | running |                 |       |
| Merge: wiring, screenshots, changelog | waiting |                 |       |

## The list and the decisions from Q&A

1. **The queue's countdown breaks when someone seeks.** The display's video has native controls, so the host can seek; the countdowns only know when the song started and how long it was paused. Decision: the display reports where the song really is (after a seek, after a stall, and now and then), and every countdown and the phone's new progress line follow that. (U1)
2. **TV Settings in tabs.** Five tabs down the left: **Accounts** (DAM login, Joysound login), **Party** (Admin password, Queue, Phones), **Sound** (Sound, Microphones), **Display** (UI scale, and the new pitch bars switch), **Advanced** (Tools, Config file, Downloads if present). (U2)
3. **Queue sheet and song list look alike.** Decision: a lifted, lighter sheet: a clearly lighter grey than the list, rounded top corners, a grab handle and a stronger shadow; queue rows sit on the sheet with no fill of their own. Both themes. (U3)
4. **Search's two tab rows take too much room.** Decision: the source (All/DAM/Joysound) moves behind a settings button; Title/Artist become two small chips on one short row with that button, which shows the source when it isn't All. (U4)
5. **Profile icon → settings icon, and settings that look like settings.** The person icon becomes a gear and the screen is "Settings". Choices (Language, Readings, Theme, Lyrics on the TV) become a **segmented pill**: one rounded row, the picked one filled with the accent and ticked, so it reads as a choice, not a tab. (U4)
6. **Up next on the TV: the initial, not the name.** In both Up next layouts (the strip while playing and the idle list) the singer shows as the initial only; the Now playing card keeps the full name. (U5)
7. **A name that doesn't fit scrolls.** Everywhere (TV and phone), a title or artist that doesn't fit slides slowly to its end, pauses, and slides back, over and over; it stays still when the device asks for reduced motion. (U5; the sheet's header at the merge)
8. **The current song shows twice on the phone** (on the bar and as the queue's first row). Decision: only on the bar, with a small "Now playing" label and a thin progress line; the list below is headed "Up next" and holds only the waiting songs. The song's page (adhoc lyrics controls) opens from the bar's title once expanded. (U3; the progress line from U1, placed at the merge)
9. **A switch for the DAM pitch bars** (the PianoRoll over DAM songs: the melody bars and the mics' pitch line). A checkbox in TV Settings, Display tab, on by default, kept on the display like UI scale. (U2)

## Rules for every phase

- Work only in the files your phase names; if you must touch another, keep it small and say so in the report.
- Don't edit `CHANGELOG.md` or `README.md`: put the lines you'd add in your report; the merge writes them.
- Don't commit screenshots: run the screenshot specs to look at your work if useful, then `git checkout -- notes/ui-refresh-screenshots` (and remove new PNGs) before committing. The merge regenerates them once.
- Native code doesn't change this round. Don't rebuild it: copy `native/index.node` from the main checkout.
- Run only the e2e specs your phase touches, with `--workers=4` (five phases test at once on this PC). The merge runs everything.

## Merge

Merge each branch as it is reviewed. Then: place U1's progress line in U3's sheet header, put the sheet header's title in U5's marquee, regenerate the screenshots, write the CHANGELOG and README lines, and run every check (`typecheck`, `lint`, `prettier --check`, `test:unit`, `build-prod` without the native step, `test:e2e:ci`, one hidden launch).
