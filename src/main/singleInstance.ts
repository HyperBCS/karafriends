// One karafriends at a time: a second launch (the launcher clicked again to
// bring the display back) would open a second display, mics and server and
// write the same queue.json. It leaves at once instead, and the first one
// comes to the front (index.ts's "second-instance"). index.ts imports this
// first, before the modules that load the config, the queue and the admin
// sessions. The lock is per user-data folder, so the e2e tests' copies, each
// with its own, don't stop each other.
import { app } from "electron";

if (!app.requestSingleInstanceLock()) {
  // Exits right here: nothing after this line runs.
  app.exit(0);
}
