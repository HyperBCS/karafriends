// Writes a small file so that a crash or power cut leaves either the old
// file or the new one, never half of one.
//
// No Electron imports, so unit tests can load this file under plain Node.
import fs from "fs";
import path from "path";

// Writes data to a temp file next to filePath, flushes it to the disk, and
// renames it over filePath. Without the flush, a filesystem may commit the
// rename before the data, and a power cut then leaves an empty file. The
// folder is flushed too where that's possible (not on Windows), so the
// rename itself lasts.
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  if (process.platform !== "win32") {
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Best effort: the file is written either way.
    }
  }
}
