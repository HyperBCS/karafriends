// Every run keeps its data in the packaged app's folder (profileDir.ts),
// yarn dev's too. index.ts imports this first: the single-instance lock,
// the config, the queue, the downloads and the display's own storage all go
// by it, and Electron takes a new one only before it's ready.
import { app } from "electron";

import { PROFILE_NAME, profileDir } from "./profileDir";

const dir = profileDir({
  packaged: app.isPackaged,
  userDataDirGiven: app.commandLine.hasSwitch("user-data-dir"),
  appData: app.getPath("appData"),
});
if (dir !== null) {
  app.setName(PROFILE_NAME);
  app.setPath("userData", dir);
}
