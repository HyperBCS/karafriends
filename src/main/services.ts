// The main process's single instances: the shared state, saved in queue.json
// next to the downloads.
import path from "path";

import { TEMP_FOLDER } from "../common/videoDownloader";
import { createStateStore } from "./state";

export const store = createStateStore(path.resolve(TEMP_FOLDER, "queue.json"));
