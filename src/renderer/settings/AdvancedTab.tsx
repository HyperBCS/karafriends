import React, { useEffect, useId, useState } from "react";

import type { AboutText } from "../../common/about";
import type {
  ApiOutput,
  ToolId,
  ToolStatus,
  ToolsStatus,
  ToolUpdate,
  ToolUpdates,
} from "../../common/api";
import { call } from "../../common/apiClient";
import {
  type Message,
  problemMessage,
  type Section,
  type SettingsActions,
} from "./actions";
import { Hint, SettingsSection } from "./controls";

// The tools, in the card's order, by name.
const TOOL_NAMES: Record<ToolId, string> = {
  ytdlp: "yt-dlp",
  ffmpeg: "ffmpeg",
};
const TOOL_IDS = Object.keys(TOOL_NAMES) as ToolId[];

// "yt-dlp", "yt-dlp and ffmpeg".
const toolList = (ids: ToolId[]) =>
  ids.map((id) => TOOL_NAMES[id]).join(" and ");

// A version as the host reads it: ffmpeg's build name after its number
// ("9.0.2-full_build-www.gyan.dev") left out.
const shortVersion = (version: string) =>
  version.match(/^\d+(\.\d+)+/)?.[0] ?? version;

// One tool's row: its name, its version, and what Check for updates found
// (nothing before a check). An overridden tool is never checked.
function ToolRow(props: {
  id: ToolId;
  tool: ToolStatus | undefined;
  update: ToolUpdate | undefined;
}) {
  const { tool, update } = props;
  let status: React.ReactNode = null;
  if (tool?.overridden) {
    status = "Custom path";
  } else if (update?.available) {
    status = (
      <span className="settingsToolNew">
        {update.latest === null ? (
          "Update available"
        ) : (
          <>
            <span aria-hidden="true">→ </span>
            <span className="settingsVisuallyHidden">Update available: </span>
            {shortVersion(update.latest)}
          </>
        )}
      </span>
    );
  } else if (update) {
    status = "Up to date";
  }
  return (
    <>
      <dt>{TOOL_NAMES[props.id]}</dt>
      <dd>
        {tool
          ? tool.version === null
            ? "Unknown version"
            : shortVersion(tool.version)
          : "…"}
      </dd>
      <dd>{status}</dd>
    </>
  );
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
        text: `Freed ${megabytes(bytes)}.${kept > 0 ? ` Kept ${kept} file${kept === 1 ? "" : "s"} in use.` : ""}`,
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

const ABOUT_TEXT_NAMES: Record<AboutText, string> = {
  license: "License",
  notices: "Third-party notices",
};

// karafriends' version, its license and where its source is, and the work
// of others it's built with. The license and the notices open here, in a
// box that scrolls; the source opens in the system's browser.
function AboutSection() {
  const { about } = window.karafriends;
  const [open, setOpen] = useState<AboutText | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | undefined>();
  const textId = useId();

  // Read each time it opens. A slow read for one closed since is dropped.
  useEffect(() => {
    if (!open) return;
    let current = true;
    about.readText(open).then(
      (read) => {
        if (!current) return;
        if (read !== null) {
          setText(read);
          return;
        }
        setOpen(null);
        setMessage({
          text: "Not included in this build.",
          tone: "problem",
        });
      },
      (err) => {
        if (!current) return;
        setOpen(null);
        setMessage(problemMessage(err));
      },
    );
    return () => {
      current = false;
    };
  }, [open]);

  const toggle = (which: AboutText) => {
    setMessage(undefined);
    setText(null);
    setOpen(open === which ? null : which);
  };

  const openSource = () => {
    setMessage(undefined);
    about.openSource().catch((err) => setMessage(problemMessage(err)));
  };

  return (
    <SettingsSection title="About" message={message}>
      <div className="settingsField">
        <p className="settingsValue">karafriends {about.version()}</p>
        <Hint>Free software under the GNU GPL v3.</Hint>
      </div>
      <div className="settingsActions">
        <button type="button" className="kfButton" onClick={openSource}>
          Source code
        </button>
        {(["license", "notices"] as const).map((which) => (
          <button
            key={which}
            type="button"
            className="kfButton"
            aria-expanded={open === which}
            aria-controls={open === which ? textId : undefined}
            onClick={() => toggle(which)}
          >
            {ABOUT_TEXT_NAMES[which]}
          </button>
        ))}
      </div>
      {open ? (
        <div className="settingsAboutBox">
          <pre
            id={textId}
            className="settingsAboutText"
            role="region"
            aria-label={ABOUT_TEXT_NAMES[open]}
            aria-busy={text === null}
            // Focused, the arrows and Page Up and Down scroll it.
            tabIndex={0}
          >
            {text ?? "Loading…"}
          </pre>
        </div>
      ) : null}
    </SettingsSection>
  );
}

// ffmpeg's and yt-dlp's versions, Check for updates and Update tools. Held
// by Settings, not the tab, so a check or an update keeps going (and its
// button stays off) while another tab is open.
export function useTools(
  say: (section: Section, message: Message | null) => void,
) {
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  // What the last Check for updates found; null before one.
  const [updates, setUpdates] = useState<ToolUpdates | null>(null);
  const [busy, setBusy] = useState<"checking" | "updating" | null>(null);

  const refresh = async () => setTools(await call("getToolsStatus", {}));
  useEffect(() => {
    refresh().catch((err) => say("tools", problemMessage(err)));
  }, []);

  const check = async () => {
    setBusy("checking");
    say("tools", null);
    try {
      const result = await call("checkTools", {});
      if (!result.ok) {
        say("tools", { text: result.reason, tone: "problem" });
        return;
      }
      setUpdates(result.updates);
      // A launch's own check may have installed a new yt-dlp since.
      await refresh();
    } catch (err) {
      say("tools", problemMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // Only the tools with a new version download. Not in the chain: ffmpeg
  // can take minutes.
  const update = async () => {
    const outdated = TOOL_IDS.filter((id) => updates?.[id]?.available);
    setBusy("updating");
    say("tools", {
      text: `Downloading ${toolList(outdated)}…${
        outdated.includes("ffmpeg") ? " This may take a few minutes." : ""
      }`,
      tone: "busy",
    });
    try {
      const result = await call("updateTools", {});
      if (result.ok) {
        say("tools", {
          text:
            result.updated.length > 0
              ? `${toolList(result.updated)} updated.`
              : "Already up to date.",
        });
        setUpdates(
          (found) =>
            found &&
            Object.fromEntries(
              Object.entries(found).map(([id, each]) => [
                id,
                { ...each, available: false },
              ]),
            ),
        );
      } else {
        say("tools", { text: result.reason, tone: "problem" });
        // Some may have updated: the next check says.
        setUpdates(null);
      }
      await refresh();
    } catch (err) {
      say("tools", problemMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return { tools, updates, busy, check, update };
}

export type Tools = ReturnType<typeof useTools>;

// The downloads, the tools, the config file's export and import, and
// About.
export default function AdvancedTab(props: {
  messages: Partial<Record<Section, Message | null>>;
  actions: SettingsActions;
  tools: Tools;
}) {
  const { messages, actions } = props;
  const { tools, updates, busy, check, update } = props.tools;
  const outdated = TOOL_IDS.some((id) => updates?.[id]?.available);
  // Off when every tool is overridden: there's nothing to check.
  const checkable = TOOL_IDS.some((id) => !tools?.[id].overridden);
  // An import says so while it runs (see importConfig).
  const importing = messages.config?.tone === "busy";
  return (
    <>
      <DownloadsSection />

      <SettingsSection title="Tools" message={messages.tools}>
        <dl className="settingsTools">
          {TOOL_IDS.map((id) => (
            <ToolRow
              key={id}
              id={id}
              tool={tools?.[id]}
              update={updates?.[id]}
            />
          ))}
        </dl>
        {checkable ? (
          <div className="settingsActions">
            {outdated ? (
              <button
                type="button"
                className="kfButton primary"
                disabled={busy !== null}
                onClick={update}
              >
                {busy === "updating" ? "Updating…" : "Update tools"}
              </button>
            ) : (
              <button
                type="button"
                className="kfButton"
                disabled={busy !== null}
                onClick={check}
              >
                {busy === "checking" ? "Checking…" : "Check for updates"}
              </button>
            )}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Configuration" message={messages.config}>
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
        <Hint>Exported files include passwords.</Hint>
      </SettingsSection>

      <AboutSection />
    </>
  );
}
