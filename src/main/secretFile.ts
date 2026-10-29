// A small secret kept between launches in a file, encrypted with Electron's
// safeStorage: DPAPI on Windows, the Keychain on macOS, the secret store on
// Linux. Where that encryption isn't available, the secret is kept for this
// run only, never written in the clear. Read on first use (safeStorage only
// works once the app is ready).
import fs from "fs";

import { app, safeStorage } from "electron";

import { writeFileAtomic } from "../common/writeFileAtomic";

export interface SecretFile<T> {
  load(): T | null;
  // null deletes it. Never throws: a secret that can't be saved is kept for
  // this run.
  save(value: T | null): void;
}

// what names the secret in log lines ("Joysound link"). Its value is never
// logged.
export function createSecretFile<T>(
  filePath: string,
  what: string,
): SecretFile<T> {
  // undefined until the file has been read.
  let value: T | null | undefined;

  const canEncrypt = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  return {
    load() {
      if (value !== undefined) return value;
      if (!fs.existsSync(filePath)) {
        value = null;
        return value;
      }
      if (!canEncrypt()) {
        // Before the app is ready, read it later.
        if (!app.isReady()) return null;
        console.warn(
          `Can't read the ${what}: this system has no encryption for it`,
        );
        value = null;
        return value;
      }
      try {
        const sealed = Buffer.from(fs.readFileSync(filePath, "utf8"), "base64");
        value = JSON.parse(safeStorage.decryptString(sealed)) as T;
      } catch (err) {
        console.error(
          `Couldn't read the ${what} in ${filePath}:`,
          (err as Error)?.message ?? err,
        );
        value = null;
      }
      return value;
    },

    save(next) {
      value = next;
      try {
        if (next === null) {
          fs.rmSync(filePath, { force: true });
        } else if (canEncrypt()) {
          const sealed = safeStorage.encryptString(JSON.stringify(next));
          writeFileAtomic(filePath, sealed.toString("base64"));
        } else {
          console.warn(
            `The ${what} is kept for this run only: this system has no encryption for it`,
          );
        }
      } catch (err) {
        console.error(
          `Couldn't save the ${what} in ${filePath}:`,
          (err as Error)?.message ?? err,
        );
      }
    },
  };
}
