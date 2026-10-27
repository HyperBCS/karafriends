import { app } from "electron";
import path from "path";

import { createConfigStore } from "./configStore";

export type { KarafriendsConfig } from "./configSchema";

app.setName("karafriends");

// The app's config: config.yaml in userData, plus environment overrides
// (KARAFRIENDS_REMOCON_PORT). Change it only through configStore.update(),
// which writes the file and tells the listeners (see services.ts).
//
// Refer to https://www.electronjs.org/docs/latest/api/app#appgetpathname
// for where the config file is. On Windows, %APPDATA%/karafriends/config.yaml
export const configStore = createConfigStore(
  path.join(app.getPath("userData"), "config.yaml"),
  process.env,
);

// KARAFRIENDS_LOCAL_ONLY=1 keeps the app off the network: the server listens
// on 127.0.0.1 only and mDNS is skipped, so phones can't connect. Tests and
// automated checks use it so each new Electron copy (one per worktree) doesn't
// raise a Windows Firewall prompt.
export const LOCAL_ONLY = process.env.KARAFRIENDS_LOCAL_ONLY === "1";

// KARAFRIENDS_HIDE_WINDOW=1 creates the display window hidden (and not full
// screen), so tests and automated checks don't take over the user's screen.
export const HIDE_WINDOW = process.env.KARAFRIENDS_HIDE_WINDOW === "1";

// The running config (configStore.get()): one object, kept up to date in
// place, for code that only reads it.
export default configStore.get();
