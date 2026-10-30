// The remote's English strings. This file defines the key set: ja.ts must
// have exactly these keys (see Messages in index.ts), and a {name} in a
// string is a variable t() requires.
//
// Keep copy short and in the imperative: "Search", "Queue song",
// "Move to top". Errors say what happened and what to do.
export const en = {
  // Shared by the primitives.
  "common.back": "Back",
  "common.clear": "Clear",
  "common.tryAgain": "Try again",
  "common.loadFailed": "Couldn't load this: {reason}",
  "common.loadMoreFailed": "Couldn't load more: {reason}",
  "common.offline": "Can't connect to the karaoke PC. Check your Wi-Fi.",
  "common.loading": "Loading",
  "common.more": "More",
  "common.cancel": "Cancel",
  "common.unknownUser": "Unknown",

  // Song sources, as the small label on a row.
  "source.dam": "DAM",
  "source.joysound": "Joysound",
  "source.youtube": "YouTube",
  "source.niconico": "Niconico",

  // Language toggle. Each language is named in itself.
  "language.label": "Language",
  "language.en": "English",
  "language.ja": "日本語",

  // Header and navigation.
  "nav.home": "Home",
  "nav.browse": "Browse",
  "nav.history": "History",
  "nav.settings": "Settings",

  // Search.
  "search.heading": "Find a song",
  "search.label": "Search",
  "search.placeholder": "Song, artist or video link",
  "search.linkHint": "Paste a YouTube or Niconico link to queue a video.",
  "search.byLabel": "Search by",
  "search.title": "Title",
  "search.artist": "Artist",
  "search.sourceLabel": "Source",
  "search.sourceAll": "All",
  "search.results": "Results",
  // A query that could be a video's ID: a row to open it, above the
  // results, since a title can look like one ("OneLastKiss").
  "search.videoById": "Open as video ID",
  "search.noResults": "No results found",
  // A count's singular is its key with ".one" (countKey in index.ts).
  "search.songCount": "{count} songs",
  "search.songCount.one": "{count} song",
  "search.failed": "Couldn't search {source}: {reason}",
  "search.moreFailed": "Couldn't load more from {source}: {reason}",

  // A song's page.
  "song.background": "Background video",
  "song.addBackground": "Add YouTube video",
  "song.backgroundLink": "YouTube link or video ID",
  "song.useVideo": "Use this video",
  "song.removeBackground": "Remove video",

  // A video's page.
  "video.views": "{count} views",
  "video.views.one": "{count} view",
  "video.infoFailed": "Couldn't get this video: {reason}",
  "video.niconicoSlow": "Niconico downloads can be slow.",

  // Lyrics for a YouTube video, and sending them line by line.
  "lyrics.heading": "Lyrics",
  "lyrics.captions": "Captions",
  "lyrics.noCaptions": "None",
  "lyrics.adhoc": "Custom lyrics",
  "lyrics.adhocPlaceholder": "Paste lyrics here",
  "lyrics.adhocHelp":
    "When your song starts, use this page to show the lyrics line by line. You can also open it from Now playing.",
  "lyrics.sendLine": "Show next line",

  // Queueing a song, and the download that comes before it.
  "queueButton.song": "Queue song",
  "queueButton.guide": "Queue song with guide vocal",
  "queueButton.guideMale": "Queue song with male guide vocal",
  "queueButton.guideFemale": "Queue song with female guide vocal",
  "queueButton.video": "Queue video",
  "queueButton.waiting": "Waiting for server",
  "queueButton.downloading": "Downloading",
  "queueButton.downloadingPercent": "Downloading {percent}%",
  "queueButton.finished": "Downloaded",
  "queueButton.queued": "Queued, up in {eta}",
  "queueButton.failed": "Couldn't download: {reason}",
  "queueButton.error": "Couldn't queue: {reason}",

  // The reasons the server gives in English (reasons.ts), inside
  // "Couldn't download: {reason}" and the like. Downloads first, as
  // src/common/downloadFailure.ts words them.
  "reason.unavailable": "Video unavailable",
  "reason.private": "Private video",
  "reason.ageRestricted": "Age-restricted video",
  "reason.membersOnly": "Members-only video",
  "reason.liveOrPaid": "Live, upcoming or paid video",
  "reason.geoBlocked": "Not available in this country",
  "reason.botCheck": "YouTube blocked the download",
  "reason.timedOut": "Download timed out",
  "reason.joysound": "Couldn't get the song from Joysound",
  "reason.noTools": "Couldn't get the download tools",
  "reason.toolFailedToStart": "Couldn't start the downloader",
  "reason.videoProcessing": "Couldn't process the video",
  "reason.damSample": "DAM sent a preview instead of the song",
  "reason.diskFull": "The karaoke PC's disk is full",
  "reason.other": "Download failed",
  "reason.alreadyAdding": "Someone is already adding this song",
  "reason.damOff": "DAM isn't available on this karaoke PC",
  "reason.joysoundOff": "Joysound isn't available on this karaoke PC",
  "reason.nicoInfo": "Invalid video ID",
  "reason.tooManyLyrics":
    "Too many queued songs have lyrics. Try again later, or queue without lyrics.",
  "reason.queueLimit": "{nickname} already has {count} songs queued",
  "reason.queueLimit.one": "{nickname} already has {count} song queued",

  // The now-playing sheet and the queue in it.
  "sheet.nowPlaying": "Now playing",
  "sheet.nothingPlaying": "Nothing playing",
  "sheet.showQueue": "Show queue",
  "sheet.hideQueue": "Hide queue",
  "sheet.showEmotes": "Show emotes",
  "sheet.showControls": "Show playback controls",
  "queue.label": "Queue",
  "queue.upNext": "Up next",
  "queue.empty": "The queue is empty",
  "queue.queuedBy": "Queued by {nickname}",
  "queue.remove": "Remove from queue",
  "queue.moveToTop": "Move to top",
  "queue.openSong": "Song page",
  "queue.guideVocal": "Guide vocal",

  // Playback and key.
  "playback.play": "Play",
  "playback.pause": "Pause",
  "playback.restart": "Restart",
  "playback.skip": "Skip",
  "playback.singerOnly": "Only the singer or an admin can control this song.",
  "pitch.key": "Key",
  "pitch.lower": "Lower key",
  "pitch.raise": "Raise key",
  "emotes.edit": "Edit emotes",
  "emotes.prompt": "Enter an emoji",

  // A DAM or Joysound page while that catalog isn't on: the host turned it
  // off or its login isn't set up (or doesn't work), it's signing in, or
  // it can't be reached.
  "catalog.off": "{source} isn't available on this karaoke PC.",
  "catalog.checking": "Connecting to {source}…",
  "catalog.unreachable": "Can't reach {source} right now.",
  // History.
  "history.heading": "History",
  // Browse: Joysound's newest songs, genres and featured lists.
  "browse.heading": "Browse",
  "browse.newSongs": "New songs",
  "browse.newSongsRow": "New on Joysound",
  "browse.newSongsNote": "Newest first",
  "browse.genres": "Popular by genre",
  "browse.featured": "Featured",
  "history.empty": "No history",
  "history.emptyMine": "No songs from this phone yet",
  "history.whose": "Whose songs",
  "history.all": "All",
  "history.mine": "Mine",
  // When a song was sung; for one sung before the server kept that, when
  // it was queued.
  "history.sungAt": "Sung {time}",
  "history.queuedAt": "Queued {time}",

  // Settings: the phone's nickname and choices, the TV's lyrics, and
  // signing in as an admin. A group's heading, then its settings.
  "settings.heading": "Settings",
  "settings.you": "You",
  "settings.thisPhone": "This phone",
  "settings.onTheTv": "TV",
  "settings.tvLyrics": "Lyrics",
  "settings.firstVisit": "Choose a nickname to show with your songs.",
  "settings.nickname": "Nickname",
  "settings.start": "Start",
  "settings.saveNickname": "Save nickname",
  "settings.admin": "Admin",
  "settings.adminPassword": "Admin password",
  "settings.signIn": "Sign in",
  "settings.signOut": "Sign out",
  "settings.signedIn": "Signed in as admin",
  // The host's "everyone is an admin": every phone is one, signed in or not.
  "settings.everyoneAdmin": "Everyone has admin access",
  "settings.wrongPassword": "Incorrect password. Ask the host.",
  "settings.noPassword": "The host hasn't set an admin password.",
  "settings.tooManyTries": "Too many attempts. Try again in a minute.",
  "settings.signInFailed": "Couldn't sign in: {reason}",

  // Reordering the queue by drag.
  "queue.dragToReorder": "Drag to reorder",
  "queue.moveFailed": "Couldn't move the song: {reason}",

  // How a Joysound song's lyrics show on the TV: the choice on its page,
  // and the phone's default in the settings. Also a queued row's label.
  "lyricsMode.label": "Lyrics on the TV",
  "lyricsMode.kana": "Kana",
  "lyricsMode.romaji": "Romaji",
  "lyricsMode.both": "Both",
  "lyricsMode.help": "Joysound songs only. Can be changed on each song's page.",

  // Joysound's guide melody level, in the settings for admins.
  "guideMelody.label": "Guide melody",
  "guideMelody.help": "Joysound songs only.",

  // The song's volume and the display's mics, in the settings for admins.
  "songVolume.label": "Song volume",
  "mics.label": "Microphones",
  "mics.none": "No microphones",
  "mics.gain": "Gain",
  "mics.echo": "Echo",
  "mics.gate": "Noise gate",
  "mics.gateOff": "Off",
  "mics.gateHelp": "Mutes the mic below this level.",
  "readings.label": "Readings",
  "readings.written": "Written",
  "readings.kana": "Kana",
  "readings.romaji": "Romaji",

  // The light or dark theme, in the settings.
  "theme.label": "Theme",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.auto": "Auto",
} as const;
