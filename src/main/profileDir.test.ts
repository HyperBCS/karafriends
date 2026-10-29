import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { profileDir } from "./profileDir";

test("yarn dev uses the packaged app's folder; a packaged app or a given folder keeps its own", () => {
  const appData = path.join("C:", "Users", "host", "AppData", "Roaming");
  assert.equal(
    profileDir({ packaged: false, userDataDirGiven: false, appData }),
    path.join(appData, "karafriends"),
  );
  assert.equal(
    profileDir({ packaged: true, userDataDirGiven: false, appData }),
    null,
  );
  assert.equal(
    profileDir({ packaged: false, userDataDirGiven: true, appData }),
    null,
  );
});
