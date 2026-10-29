// No Electron imports, so unit tests can load this file under plain Node.
import path from "path";

// The app's data folder's name: <appData>/karafriends.
export const PROFILE_NAME = "karafriends";

// The folder for the settings, logins, queue and downloads (userData) that
// a run should use, or null to keep Electron's. Electron names it after the
// app, from the package; yarn dev starts Electron on the main script
// instead, so it would be <appData>/Electron, apart from the packaged app's.
// A --user-data-dir (the e2e tests, the checks) keeps its own.
export function profileDir(run: {
  packaged: boolean;
  userDataDirGiven: boolean;
  appData: string;
}): string | null {
  if (run.packaged || run.userDataDirGiven) return null;
  return path.join(run.appData, PROFILE_NAME);
}
