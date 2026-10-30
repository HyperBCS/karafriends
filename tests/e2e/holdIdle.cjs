// The e2e fixture's holdIdle option: loaded into the app's main process with
// -r, it keeps the display's popSong from ever answering, so the idle screen
// stays up over a queue (no song starts). It waits for the main process to
// register the display's IPC handler, then wraps it. ipcMain's
// _invokeHandlers is Electron's own, not an API: if it goes, songs start
// again, and the tests that hold the idle screen fail.
let tries = 0;
const wrap = () => {
  let ipcMain;
  try {
    ({ ipcMain } = require("electron"));
  } catch {
    // Too early: Electron's module isn't there yet.
  }
  const handlers = ipcMain && ipcMain._invokeHandlers;
  if (!handlers || !handlers.has("api")) {
    if (++tries < 2000) setTimeout(wrap, 5);
    return;
  }
  const call = handlers.get("api");
  handlers.set("api", (event, method, input) =>
    method === "popSong" ? new Promise(() => {}) : call(event, method, input),
  );
};
setTimeout(wrap, 0);
