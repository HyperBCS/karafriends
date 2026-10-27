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
  "common.offline": "Can't reach karafriends. Check the Wi-Fi.",
  "common.downloadFailed": "Couldn't download. Try another video.",
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
  "search.byLabel": "Search by",
  "search.title": "Title",
  "search.artist": "Artist",
  "search.sourceLabel": "Source",
  "search.sourceAll": "All",
  "search.titleJoysound": "Title (Joysound)",
  "search.artistJoysound": "Artist (Joysound)",
  "search.titleDam": "Title (DAM)",
  "search.artistDam": "Artist (DAM)",
  "search.bySongTitle": "Search by song title",
  "search.byArtistName": "Search by artist name",
  "search.placeholder": "Start typing...",
  "search.noResults": "No results found",
  "search.addYoutube": "Add YouTube video",
  "search.addNiconico": "Add Niconico video",
  "search.youtubePlaceholder": "YouTube video URL or ID",
  "search.niconicoPlaceholder": "Niconico video URL or ID",
  "search.getVideoInfo": "Get Video Info",

  // Queueing a song, and the download that comes before it.
  "queueButton.song": "Queue song",
  "queueButton.video": "Queue video",
  "queueButton.waiting": "Waiting for server...",
  "queueButton.downloading": "Downloading",
  "queueButton.downloadingPercent": "Downloading -- {percent}%",
  "queueButton.finished": "Finished Downloading",

  // The now-playing sheet and the queue in it.
  "sheet.nowPlaying": "Now playing",
  "sheet.showQueue": "Show queue",
  "sheet.hideQueue": "Hide queue",
  "sheet.showEmotes": "Show emotes",
  "sheet.showControls": "Show playback controls",
  "queue.label": "Queue",
  "queue.empty": "The queue is empty",
  "queue.queuedBy": "Queued by {nickname}",
  "queue.remove": "Remove from queue",
  "queue.moveToTop": "Move to top",
  "queue.upNext": "Up next",

  // Playback and key.
  "playback.play": "Play",
  "playback.pause": "Pause",
  "playback.restart": "Restart",
  "playback.skip": "Skip",
  "pitch.key": "Key",
  "pitch.lower": "Lower the key",
  "pitch.raise": "Raise the key",

  // History.
  "history.heading": "History",
  "history.empty": "No history",
} as const;
