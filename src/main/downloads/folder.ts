// The downloads folder as a whole, for the display's Settings: how much it
// holds, and clearing it but for the files in use. The saved queue
// (queue.json) lives there too, and is never counted or deleted.
//
// No Electron imports, so unit tests can load this file under plain Node.
import fs from "fs";
import path from "path";

import type { QueueItem } from "../../common/api";

// A song's files, by what jobs.ts names them after: its kind, its song or
// video ID, and the streaming URL index for DAM, the YouTube background for
// Joysound (null: Joysound's own).
export interface SongFiles {
  kind: QueueItem["kind"];
  songId: string;
  suffix: string | null;
}

// How the names of a song's files start: its videos, the half-made ones,
// its lyrics and its logs.
export function filePrefixes({ kind, songId, suffix }: SongFiles): string[] {
  switch (kind) {
    case "dam":
      return [`${songId}-${suffix}.`, `dam-${songId}.`];
    case "joysound":
      return [
        `joysound-${songId}.`,
        `joysound-${songId}-${suffix ?? "default"}`,
      ];
    case "youtube":
      return [`yt-${songId}.`];
    case "nico":
      return [`nico-${songId}.`];
  }
}

// The files in folder but the saved queue's, with their sizes; none if it
// can't be listed.
function downloadFiles(folder: string): { name: string; bytes: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith("queue.json"))
    .flatMap((name) => {
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

// Deletes every file in folder but the saved queue and inUse's files. kept
// counts those, and any that can't be deleted (on Windows, one a program
// has open).
export function clearFolder(
  folder: string,
  inUse: readonly SongFiles[],
): { deleted: number; bytes: number; kept: number } {
  const prefixes = inUse.flatMap(filePrefixes);
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
  const filename = path.join(folder, `${songId}-${suffix}.mp4`);
  if (!fs.existsSync(filename)) return false;
  try {
    fs.rmSync(filename);
    return true;
  } catch (err) {
    console.error(`Couldn't delete ${filename}:`, err);
    return false;
  }
}
