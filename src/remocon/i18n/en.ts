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
  "common.offline": "Can't reach karafriends. Check the Wi-Fi.",
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
  "nav.history": "History",
  "nav.profile": "Profile",

  // Search.
  "search.heading": "Find a song",
  "search.label": "Search",
  "search.placeholder": "Song, artist, or a video link",
  "search.linkHint": "Paste a YouTube or Niconico link to queue the video.",
  "search.byLabel": "Search by",
  "search.title": "Title",
  "search.artist": "Artist",
  "search.sourceLabel": "Source",
  "search.sourceAll": "All",
  "search.results": "Results",
  "search.noResults": "No results found",
  "search.songCount": "{count} songs",
  "search.failed": "Couldn't search {source}: {reason}",
  "search.moreFailed": "Couldn't load more from {source}: {reason}",

  // A song's page.
  "song.background": "Background video",
  "song.addBackground": "Play a YouTube video behind the lyrics",
  "song.backgroundLink": "YouTube link or video ID",
  "song.useVideo": "Use this video",
  "song.removeBackground": "Remove the video",

  // A video's page.
  "video.views": "{count} views",
  "video.infoFailed": "Couldn't get this video: {reason}",
  "video.niconicoSlow": "Niconico videos take a while to download.",

  // Lyrics for a YouTube video, and sending them line by line.
  "lyrics.heading": "Lyrics",
  "lyrics.captions": "Captions",
  "lyrics.noCaptions": "None",
  "lyrics.adhoc": "Your own lyrics",
  "lyrics.adhocPlaceholder": "Paste the lyrics here, one line per line.",
  "lyrics.adhocHelp":
    "While your song plays, tap it in the queue to show these line by line.",
  "lyrics.sendLine": "Tap here to show the next line",

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
  "queueButton.error": "Not queued: {reason}",

  // The now-playing sheet and the queue in it.
  "sheet.nowPlaying": "Now playing",
  "sheet.nothingPlaying": "Nothing playing",
  "sheet.showQueue": "Show queue",
  "sheet.hideQueue": "Hide queue",
  "sheet.showEmotes": "Show emotes",
  "sheet.showControls": "Show playback controls",
  "queue.label": "Queue",
  "queue.empty": "The queue is empty",
  "queue.queuedBy": "Queued by {nickname}",
  "queue.remove": "Remove from queue",
  "queue.moveToTop": "Move to top",

  // Playback and key.
  "playback.play": "Play",
  "playback.pause": "Pause",
  "playback.restart": "Restart",
  "playback.skip": "Skip",
  "pitch.key": "Key",
  "pitch.lower": "Lower the key",
  "pitch.raise": "Raise the key",
  "emotes.edit": "Change emotes",
  "emotes.prompt": "Type the emoji to show here",

  // Notifications on the phone.
  "notification.upSoon": "{name} is up in about {eta}.",
  "notification.failed": "Couldn't download {name}: {reason}",

  // History.
  "history.heading": "History",
  "history.empty": "No history",

  // Profile, and signing in as an admin.
  "profile.heading": "Profile",
  "profile.firstVisit":
    "Pick a nickname. It shows next to the songs you queue.",
  "profile.nickname": "Nickname",
  "profile.start": "Start",
  "profile.saveNickname": "Save nickname",
  "profile.notifications": "Notifications",
  "profile.notificationsOn": "Turn on notifications",
  "profile.notificationsAllowed":
    "On: this phone tells you when your song is up soon.",
  "profile.notificationsBlocked": "Off. Allow them in the browser's settings.",
  "profile.admin": "Admin",
  "profile.adminPassword": "Admin password",
  "profile.signIn": "Sign in",
  "profile.signOut": "Sign out",
  "profile.signedIn": "You're an admin",
  "profile.wrongPassword": "Wrong password. Ask the host for it.",
  "profile.noPassword": "The host hasn't set an admin password.",
  "profile.tooManyTries": "Too many tries. Wait a minute, then try again.",
  "profile.signInFailed": "Couldn't sign in: {reason}",

  // Reordering the queue by drag.
  "queue.dragToReorder": "Drag to reorder",
  "queue.moveFailed": "Couldn't move the song: {reason}",

  // How a Joysound song's lyrics show on the TV: the choice on its page,
  // and the phone's default on the profile. Also a queued row's label.
  "lyricsMode.label": "Lyrics on the TV",
  "lyricsMode.kana": "Kana",
  "lyricsMode.romaji": "Romaji",
  "lyricsMode.both": "Both",
  "lyricsMode.help":
    "For Joysound songs. You can change it for one song on its page.",

  // Joysound's guide melody level, on the profile for admins.
  "guideMelody.label": "Guide melody",
  "guideMelody.help": "For Joysound songs.",
  "readings.label": "Readings",
  "readings.written": "Written",
  "readings.kana": "Kana",
  "readings.romaji": "Romaji",
} as const;
