// A small secret kept between launches in a file, encrypted with Electron's
// safeStorage: DPAPI on Windows (with the key in the profile's Local State),
// the Keychain on macOS, the secret store on Linux. Where that encryption
// isn't available, the secret is kept for this run only, never written in
// the clear. Read on first use, once the app is ready.
import fs from "fs";

import { app, safeStorage } from "electron";

import { writeFileAtomic } from "../common/writeFileAtomic";

export interface SecretFile<T> {
  // Never rejects: a file that can't be read is no secret.
  load(): Promise<T | null>;
  // null deletes it. Saves run in order, and never reject: a secret that
  // can't be saved is kept for this run.
  save(value: T | null): Promise<void>;
}

// what names the secret in log lines ("Joysound link"). Its value is never
// logged.
export function createSecretFile<T>(
  filePath: string,
  what: string,
): SecretFile<T> {
  // undefined until the file has been read (or a value saved).
  let value: T | null | undefined;
  let saving: Promise<void> = Promise.resolve();

  const canEncrypt = async () => {
    try {
      await app.whenReady();
      return await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      return false;
    }
  };

  const write = async (next: T | null) => {
    if (next === null) {
      fs.rmSync(filePath, { force: true });
    } else if (await canEncrypt()) {
      const sealed = await safeStorage.encryptStringAsync(JSON.stringify(next));
      writeFileAtomic(filePath, sealed.toString("base64"));
    } else {
      console.warn(
        `The ${what} is kept for this run only: this system has no encryption for it`,
      );
    }
  };

  const save = (next: T | null): Promise<void> => {
    value = next;
    saving = saving
      .then(() => write(next))
      .catch((err) => {
        console.error(
          `Couldn't save the ${what} in ${filePath}:`,
          (err as Error)?.message ?? err,
        );
      });
    return saving;
  };

  const read = async (): Promise<T | null> => {
    if (!fs.existsSync(filePath)) return null;
    if (!(await canEncrypt())) {
      console.warn(
        `Can't read the ${what}: this system has no encryption for it`,
      );
      return null;
    }
    try {
      const sealed = Buffer.from(fs.readFileSync(filePath, "utf8"), "base64");
      const { result, shouldReEncrypt } =
        await safeStorage.decryptStringAsync(sealed);
      const secret = JSON.parse(result) as T;
      // The system's key has changed: written again with the new one.
      if (shouldReEncrypt) void save(secret);
      return secret;
    } catch (err) {
      console.error(
        `Couldn't read the ${what} in ${filePath}:`,
        (err as Error)?.message ?? err,
      );
      return null;
    }
  };

  return {
    async load() {
      if (value !== undefined) return value;
      const secret = await read();
      // Unless a save came in meanwhile.
      if (value === undefined) value = secret;
      return value;
    },
    save,
  };
}
