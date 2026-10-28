// The admin password, as config.yaml keeps it: adminPasswordSalt (random,
// one per install) and adminPasswordHash, the scrypt hash of the password
// with that salt. README's "Running a party" has a one-line `node -e` that
// computes the same two values, so keep its parameters in step with these.
//
// No Electron imports: the app, the unit tests and the e2e fixture all use
// this file.
import crypto from "crypto";
import { promisify } from "util";

// Node's scrypt defaults, spelled out so the README's snippet can match them.
export const ADMIN_PASSWORD_SCRYPT = {
  keyLength: 64,
  options: { N: 16384, r: 8, p: 1 },
} as const;

// A new random salt: 16 bytes as hex.
export function newAdminSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

// The hash of password with salt, as hex. The salt is used as the text it
// is (its UTF-8 bytes), not decoded from hex.
export function hashAdminPassword(password: string, salt: string): string {
  return crypto
    .scryptSync(
      password,
      salt,
      ADMIN_PASSWORD_SCRYPT.keyLength,
      ADMIN_PASSWORD_SCRYPT.options,
    )
    .toString("hex");
}

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keyLength: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// Whether password is the admin password. Never, while none is set. Hashes
// off the main thread (unlike hashAdminPassword), so a burst of sign-in tries
// doesn't stall the app.
export async function isAdminPassword(
  password: string,
  { adminPasswordHash, adminPasswordSalt }: AdminPasswordConfig,
): Promise<boolean> {
  if (adminPasswordHash === "" || adminPasswordSalt === "") return false;
  const expected = Buffer.from(adminPasswordHash, "hex");
  const actual = await scrypt(
    password,
    adminPasswordSalt,
    ADMIN_PASSWORD_SCRYPT.keyLength,
    ADMIN_PASSWORD_SCRYPT.options,
  );
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

export interface AdminPasswordConfig {
  // Empty: no phone can become an admin.
  adminPasswordHash: string;
  adminPasswordSalt: string;
}
