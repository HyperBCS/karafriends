// What a song's downloaded files are called in the downloads folder. The
// main process's jobs write them, the folder keeps them with their song
// (folder.ts), and the display plays them as karafriends://local/<name>, so
// all of them take the names from here.
//
// No Electron or DOM imports: the main process, the display and the unit
// tests all load this file.

// A song's files, by what they're named after: its kind, its song or video
// ID (for Joysound's guide-vocal version, joysoundFilesId's), and the
// streaming URL index for DAM, the YouTube background for Joysound (null:
// Joysound's own). Also what identifies a download.
export interface SongFiles {
  kind: "dam" | "joysound" | "youtube" | "nico";
  songId: string;
  suffix: string | null;
}

// A queued song, or one being queued.
export type SongOfFiles =
  | { kind: "dam"; songId: string; streamingUrlIdx: number }
  | {
      kind: "joysound";
      songId: string;
      youtubeVideoId: string | null;
      guideVocal?: boolean;
    }
  | { kind: "youtube" | "nico"; songId: string };

// The ID a Joysound song's files and download go by. Its guide-vocal
// version is another recording, with its own timing (its own lyrics file):
// the song number with a "v" after it. (Joysound's numbers are digits.)
export function joysoundFilesId(
  songId: string,
  guideVocal: boolean | undefined,
): string {
  return guideVocal ? `${songId}v` : songId;
}

export function songFilesOf(song: SongOfFiles): SongFiles {
  switch (song.kind) {
    case "dam":
      return {
        kind: "dam",
        songId: song.songId,
        suffix: song.streamingUrlIdx.toString(),
      };
    case "joysound":
      return {
        kind: "joysound",
        songId: joysoundFilesId(song.songId, song.guideVocal),
        suffix: song.youtubeVideoId,
      };
    default:
      return { kind: song.kind, songId: song.songId, suffix: null };
  }
}

export interface SongFileNames {
  // What the display plays.
  video: string;
  // The download's log (ffmpeg's, or yt-dlp's for YouTube and Niconico).
  log: string;
  // YouTube: the captions, when asked for.
  captions?: string;
  // Joysound: the lyrics, shared by the song's backgrounds.
  telop?: string;
  // Joysound with a YouTube background: yt-dlp's log.
  backgroundLog?: string;
  // How the names of its files start: these, its half-made files and its
  // logs. (IDs have no ".", so another song's files never match.)
  prefixes: string[];
}

export function songFileNames({
  kind,
  songId,
  suffix,
}: SongFiles): SongFileNames {
  switch (kind) {
    case "dam": {
      const video = `${songId}-${suffix}`;
      return {
        video: `${video}.mp4`,
        log: `dam-${video}.log`,
        prefixes: [`${video}.`, `dam-${video}.`],
      };
    }
    case "joysound": {
      const base = `joysound-${songId}-${suffix ?? "default"}`;
      return {
        // "-opus": the sound is Opus (joysoundJob says why). A video from
        // before, <base>.mp4 with Joysound's Vorbis, isn't used again.
        video: `${base}-opus.mp4`,
        log: `${base}.log`,
        telop: `joysound-${songId}.joy_02`,
        ...(suffix !== null && { backgroundLog: `${base}.yt.log` }),
        // The padding steps name their files <base>-opus-pad.mp4 and so on.
        prefixes: [`joysound-${songId}.`, `${base}.`, `${base}-`],
      };
    }
    case "youtube":
      return {
        video: `yt-${songId}.mp4`,
        log: `yt-${songId}.log`,
        captions: `yt-${songId}.vtt`,
        prefixes: [`yt-${songId}.`],
      };
    case "nico":
      return {
        video: `nico-${songId}.mp4`,
        log: `nico-${songId}.log`,
        prefixes: [`nico-${songId}.`],
      };
  }
}
