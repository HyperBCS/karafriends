// localStorage that never throws, for the remote's few saved choices (its
// identity, language, theme, readings, the sheet's state, the emotes).
//
// A phone may block storage for the page (site data blocked, an old
// iPhone's private tab), and then reading or writing localStorage throws.
// Here a value that can't be saved is kept in memory instead, so the phone
// works as usual until the page reloads; a value that can't be read is
// the one kept in memory, or null.
//
// No React and no DOM types beyond localStorage, so unit tests can load it
// under plain Node (with a fake localStorage on globalThis, or none).

const memory = new Map<string, string>();

function local(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage;
}

export function getItem(key: string): string | null {
  try {
    const value = local()?.getItem(key);
    if (value !== null && value !== undefined) return value;
  } catch {
    // Blocked: the value kept in memory, if any.
  }
  return memory.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  try {
    const storage = local();
    if (storage) {
      storage.setItem(key, value);
      memory.delete(key);
      return;
    }
  } catch {
    // Blocked or full: kept for this page only.
  }
  memory.set(key, value);
}

export function removeItem(key: string): void {
  memory.delete(key);
  try {
    local()?.removeItem(key);
  } catch {
    // Blocked: nothing was saved.
  }
}
