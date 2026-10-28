import React, { useEffect, useState } from "react";

import type { ApiOutput, ToolStatus, ToolsStatus } from "../../common/api";
import { call } from "../../common/apiClient";
import {
  type Message,
  problemMessage,
  type Section,
  type SettingsActions,
} from "./actions";
import { Hint, SettingsSection } from "./controls";

function toolLine(tool: ToolStatus): string {
  const version = tool.version ?? "Version not known yet";
  if (tool.overridden) return `${version} · your own copy`;
  if (tool.updatedAt === null) return version;
  const date = new Date(tool.updatedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${version} · downloaded ${date}`;
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

// The downloaded songs, kept so they start at once the next time: how much
// they take, and a button that deletes them, but the files in use.
function DownloadsSection() {
  const [info, setInfo] = useState<ApiOutput<"downloadsInfo"> | null>(null);
  const [message, setMessage] = useState<Message | undefined>();
  const [clearing, setClearing] = useState(false);

  const refresh = () =>
    call("downloadsInfo", {}).then(setInfo, (err) =>
      setMessage(problemMessage(err)),
    );
  useEffect(() => {
    void refresh();
  }, []);

  const clear = async () => {
    setClearing(true);
    try {
      const { bytes, kept } = await call("clearDownloads", {});
      setMessage({
        text: `Freed ${megabytes(bytes)}${kept > 0 ? `. ${kept} kept: playing, queued or downloading` : ""}.`,
      });
      await refresh();
    } catch (err) {
      setMessage(problemMessage(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <SettingsSection title="Downloads" message={message}>
      <div className="settingsActions">
        <p className="settingsValue">
          {info
            ? `${info.files} file${info.files === 1 ? "" : "s"}, ${megabytes(info.bytes)}`
            : "…"}
        </p>
        <button
          type="button"
          className="kfButton"
          disabled={clearing}
          onClick={clear}
        >
          Clear downloads
        </button>
      </div>
    </SettingsSection>
  );
}

// ffmpeg's and yt-dlp's versions, and Update tools. Held by Settings, not
// the tab, so an update keeps going (and its button stays off) while
// another tab is open.
export function useTools(say: (section: Section, message: Message) => void) {
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    call("getToolsStatus", {}).then(setTools, (err) =>
      say("tools", problemMessage(err)),
    );
  }, []);

  // Not in the chain: it can take minutes.
  const update = async () => {
    setUpdating(true);
    say("tools", {
      text: "Downloading ffmpeg and yt-dlp. This can take about 5 minutes.",
      tone: "busy",
    });
    try {
      const result = await call("updateTools", {});
      say(
        "tools",
        result.ok
          ? { text: "Tools updated." }
          : { text: result.reason, tone: "problem" },
      );
      setTools(await call("getToolsStatus", {}));
    } catch (err) {
      say("tools", problemMessage(err));
    } finally {
      setUpdating(false);
    }
  };

  return { tools, updating, update };
}

export type Tools = ReturnType<typeof useTools>;

// The downloads, the tools, and the config file's export and import.
export default function AdvancedTab(props: {
  messages: Partial<Record<Section, Message | null>>;
  actions: SettingsActions;
  tools: Tools;
}) {
  const { messages, actions } = props;
  const { tools, updating, update } = props.tools;
  // An import says so while it runs (see importConfig).
  const importing = messages.config?.tone === "busy";
  return (
    <>
      <DownloadsSection />

      <SettingsSection title="Tools" message={messages.tools}>
        <dl className="settingsTools">
          <dt>yt-dlp</dt>
          <dd>{tools ? toolLine(tools.ytdlp) : "…"}</dd>
          <dt>ffmpeg</dt>
          <dd>{tools ? toolLine(tools.ffmpeg) : "…"}</dd>
        </dl>
        <div className="settingsActions">
          <button
            type="button"
            className="kfButton"
            disabled={updating}
            onClick={update}
          >
            {updating ? "Updating tools…" : "Update tools"}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection title="Config file" message={messages.config}>
        <div className="settingsActions">
          <button
            type="button"
            className="kfButton"
            disabled={importing}
            onClick={actions.exportConfig}
          >
            Export config
          </button>
          <button
            type="button"
            className="kfButton"
            disabled={importing}
            onClick={actions.importConfig}
          >
            Import config
          </button>
        </div>
        <Hint>Includes the logins and passwords.</Hint>
      </SettingsSection>
    </>
  );
}
