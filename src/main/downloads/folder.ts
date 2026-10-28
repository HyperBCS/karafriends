// The downloads folder as a whole: how much it holds and clearing it but
// for the files in use, for the display's Settings; at launch, sweeping
// what downloads the app didn't finish left; and moving over what older
// versions kept in the temp folder.
//
// No Electron imports, so unit tests can load this file under plain Node.
import fs from "fs";
import path from "path";

import { songFileNames, type SongFiles } from "../../common/songFiles";

// The files in folder, with their sizes; none if it can't be listed.
function downloadFiles(folder: string): { name: string; bytes: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    try {
      const stat = fs.statSync(path.join(folder, name));
      return stat.isFile() ? [{ name, bytes: stat.size }] : [];
    } catch {
      return [];
    }
  });
}

export function folderInfo(folder: string): { files: number; bytes: number } {
  const files = downloadFiles(folder);
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

// Deletes every file in folder but inUse's files. kept counts those,
// and any that can't be deleted (on Windows, one a program has open).
export function clearFolder(
  folder: string,
  inUse: readonly SongFiles[],
): { deleted: number; bytes: number; kept: number } {
  const prefixes = inUse.flatMap((song) => songFileNames(song).prefixes);
  const result = { deleted: 0, bytes: 0, kept: 0 };
  for (const file of downloadFiles(folder)) {
    if (prefixes.some((prefix) => file.name.startsWith(prefix))) {
      result.kept++;
      continue;
    }
    try {
      fs.rmSync(path.join(folder, file.name));
      result.deleted++;
      result.bytes += file.bytes;
    } catch (err) {
      console.error(`Couldn't delete ${file.name}:`, err);
      result.kept++;
    }
  }
  return result;
}

// Deletes a DAM song's downloaded video. Whether there was one.
export function deleteDamVideo(
  folder: string,
  songId: string,
  suffix: string,
): boolean {
  const filename = path.join(
    folder,
    songFileNames({ kind: "dam", songId, suffix }).video,
  );
  if (!fs.existsSync(filename)) return false;
  try {
    fs.rmSync(filename);
    return true;
  } catch (err) {
    console.error(`Couldn't delete ${filename}:`, err);
    return false;
  }
}

// Moves a file, also to another disk (the temp folder can be RAM). Whether
// it did.
function moveFile(from: string, to: string): boolean {
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      fs.copyFileSync(from, to);
      fs.rmSync(from);
    }
    return true;
  } catch (err) {
    console.error(`Couldn't move ${from} to ${to}:`, err);
    return false;
  }
}

// Older versions kept the saved queue with the downloads in the temp
// folder, oldFolder. Moves it to queueFile, once: unless there's one there
// already. Whether it did.
export function moveOldQueue(oldFolder: string, queueFile: string): boolean {
  const oldQueue = path.join(oldFolder, "queue.json");
  if (fs.existsSync(queueFile) || !fs.existsSync(oldQueue)) return false;
  console.info(`Moving ${oldQueue} to ${queueFile}`);
  return moveFile(oldQueue, queueFile);
}

// Moves songs' files from oldFolder to folder, but those folder has
// already: the files of the songs a queue moved by moveOldQueue holds. The
// rest of oldFolder stays, for the system to clear with the temp folder.
export function moveOldSongFiles(
  oldFolder: string,
  folder: string,
  songs: readonly SongFiles[],
): void {
  const prefixes = songs.flatMap((song) => songFileNames(song).prefixes);
  for (const { name } of downloadFiles(oldFolder)) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (fs.existsSync(path.join(folder, name))) continue;
    moveFile(path.join(oldFolder, name), path.join(folder, name));
  }
}

// Deletes what downloads that never finished left in folder: for launch,
// when none is running. A finished file has one "." in its name
// (songFileNames), so the rest go: yt-dlp's .part, .ytdl and .f<format>
// files, the jobs' .tmp markers and .source.mp4 files. A video whose .tmp
// marker is there is half-made, so it goes too, with the files named after
// it (Joysound's padding steps'). Logs stay, as they say why. Returns how
// many it deleted.
export function sweepHalfDone(folder: string): number {
  const names = downloadFiles(folder).map((file) => file.name);
  // <base>.mp4.tmp marks <base>.mp4 half-made.
  const halfMade = names
    .filter((name) => name.endsWith(".mp4.tmp"))
    .map((name) => name.slice(0, -".mp4.tmp".length));
  let deleted = 0;
  for (const name of names) {
    if (name.endsWith(".log")) continue;
    const finished = name.split(".").length === 2;
    const ofHalfMade = halfMade.some(
      (base) => name.startsWith(`${base}.`) || name.startsWith(`${base}-`),
    );
    if (finished && !ofHalfMade) continue;
    try {
      fs.rmSync(path.join(folder, name));
      deleted++;
    } catch (err) {
      console.error(`Couldn't delete ${name}:`, err);
    }
  }
  return deleted;
}
