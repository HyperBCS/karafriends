import React, { useEffect, useRef, useState } from "react";

import {
  type ApiOutput,
  type LoginService,
  type SettingsChanges,
  type ToolStatus,
  type ToolsStatus,
} from "../common/api";
import { call } from "../common/apiClient";
import "./global";
import HostnameSetting from "./HostnameSetting";
import {
  AddMicrophone,
  MicModeSetting,
  MicOutputSetting,
  MicrophoneSetting,
  type MicLevels,
} from "./MicrophoneSetting";
import {
  asioStatus,
  InputDevice,
  linuxAudio,
  type MicMode,
  type MicOutput,
  outputDevices,
  refreshInputDevices,
} from "./nativeAudio";
import { AV_OFFSETS, UI_SCALES } from "./playback";
import "./Settings.css";

type Loaded = ApiOutput<"getSettings">;

type Section =
  LoginService | "admin" | "queue" | "network" | "tools" | "config";

// What happened in a section, under it.
interface Message {
  text: string;
  list?: string[];
  tone?: "busy" | "problem";
}

// A text or number field that saves when the host leaves it or presses
// Enter, if it changed.
function TextSetting(props: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  type?: "text" | "password" | "number";
}) {
  const [draft, setDraft] = useState(props.value);
  const [value, setValue] = useState(props.value);
  // A new saved value replaces the draft, unless the host is typing one.
  if (props.value !== value) {
    setValue(props.value);
    if (draft === value) setDraft(props.value);
  }
  const commit = () => {
    if (draft !== props.value) props.onCommit(draft);
  };
  return (
    <label className="kfLabel">
      {props.label}
      <input
        className="kfField"
        type={props.type ?? "text"}
        value={draft}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        // A masked password is replaced, not added to.
        onFocus={
          props.type === "password"
            ? (event) => event.target.select()
            : undefined
        }
      />
    </label>
  );
}

// A checkbox that saves at once, and shows the new state while it does.
// onChange says whether it saved; if not, the box goes back.
function Checkbox(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => Promise<boolean>;
}) {
  const [checked, setChecked] = useState(props.checked);
  const [saved, setSaved] = useState(props.checked);
  if (props.checked !== saved) {
    setSaved(props.checked);
    setChecked(props.checked);
  }
  return (
    <label className="kfCheckbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          setChecked(event.target.checked);
          void props.onChange(event.target.checked).then((ok) => {
            if (!ok) setChecked(props.checked);
          });
        }}
      />
      {props.label}
    </label>
  );
}

function SettingsSection(props: {
  title: string;
  message?: Message;
  children: React.ReactNode;
}) {
  const { message } = props;
  return (
    <section className="settingsSection" aria-label={props.title}>
      <h2>{props.title}</h2>
      {props.children}
      {message ? (
        <div className={`settingsMessage ${message.tone ?? ""}`} role="status">
          <p>{message.text}</p>
          {message.list && message.list.length > 0 ? (
            <ul>
              {message.list.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

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
  const problem = (err: unknown): Message => ({
    text: String((err as Error)?.message ?? err),
    tone: "problem",
  });

  const refresh = () =>
    call("downloadsInfo", {}).then(setInfo, (err) => setMessage(problem(err)));
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
      setMessage(problem(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <SettingsSection title="Downloads" message={message}>
      <p className="settingsNote">
        {info
          ? `${info.files} file${info.files === 1 ? "" : "s"}, ${megabytes(info.bytes)}`
          : "…"}
      </p>
      <div className="settingsActions">
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

const SERVICE_NAMES = { dam: "DAM", joysound: "Joysound" } as const;

// The settings screen, over everything. Every field saves as the host
// leaves it; each section says under it what happened.
export default function Settings(props: {
  onClose: () => void;
  hostname: string;
  onHostnameChange: (hostname: string) => void;
  mics: InputDevice[];
  micLevels: (mic: InputDevice) => MicLevels;
  // index is mics.length for a new mic.
  onChangeMic: (index: number, name: string, channel: number) => void;
  onChangeLevels: (mic: InputDevice, levels: MicLevels) => void;
  onRemoveMic: (index: number) => void;
  micOutput: MicOutput;
  onMicOutputChange: (output: MicOutput) => void;
  micMode: MicMode;
  onMicModeChange: (mode: MicMode) => void;
  avOffsetMs: number;
  onAvOffsetChange: (offsetMs: number) => void;
  uiScale: number;
  onUiScaleChange: (scale: number) => void;
  audioLatencyMs: number;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [messages, setMessages] = useState<
    Partial<Record<Section, Message | null>>
  >({});
  const [adminDraft, setAdminDraft] = useState("");
  const [tools, setTools] = useState<ToolsStatus | null>(null);
  const [updatingTools, setUpdatingTools] = useState(false);
  // Listed each time Settings opens: the outputs, and on Linux the inputs
  // too, so a mic or an interface switched on since can be picked.
  const [outputs] = useState(() => {
    refreshInputDevices();
    return outputDevices();
  });
  const [asio] = useState(asioStatus);
  // On Linux, the sound system and the mics' buffer sizes; null elsewhere.
  const [linux] = useState(linuxAudio);
  // What the native side says about the output while the mics work ("ok:
  // <note>"): that the chosen one is missing or won't open, say.
  const micStatus = props.mics[0]?.status();
  const outputNote = micStatus?.startsWith("ok: ") ? micStatus.slice(4) : null;
  // Saves, tests and imports run one after another, so a Test login
  // clicked right after typing tests what was just saved.
  const chain = useRef<Promise<void>>(Promise.resolve());

  const say = (section: Section, message: Message | null) =>
    setMessages((previous) => ({ ...previous, [section]: message }));

  const reload = async () => setLoaded(await call("getSettings", {}));

  useEffect(() => {
    reload().catch((err) => setLoadProblem(String(err?.message ?? err)));
    call("getToolsStatus", {}).then(setTools, (err) =>
      say("tools", { text: String(err?.message ?? err), tone: "problem" }),
    );
  }, []);

  // Runs task after the ones before it, and shows what it says (or its
  // error) under the section. Settles when it has.
  const act = (section: Section, task: () => Promise<Message | null>) =>
    (chain.current = chain.current.then(async () => {
      try {
        say(section, await task());
      } catch (err) {
        say(section, {
          text: String((err as Error)?.message ?? err),
          tone: "problem",
        });
      }
    }));

  // Whether it saved.
  const save = (section: Section, changes: SettingsChanges) => {
    let saved = false;
    return act(section, async () => {
      const result = await call("setSettings", { settings: changes });
      if (!result.ok) {
        return { text: result.problems.join(" "), tone: "problem" };
      }
      saved = true;
      await reload();
      return { text: "Saved." };
    }).then(() => saved);
  };

  // A whole number, or a message saying it isn't one.
  const saveNumber = (
    section: Section,
    key: "paxSongQueueLimit" | "remoconPort",
    label: string,
    value: string,
  ) => {
    if (!/^\d+$/.test(value.trim())) {
      say(section, {
        text: `${label}: enter a whole number.`,
        tone: "problem",
      });
      return;
    }
    save(section, { [key]: Number(value) });
  };

  const testLogin = (service: LoginService) => {
    say(service, { text: "Signing in…", tone: "busy" });
    act(service, async () => {
      const result = await call("testLogin", { service });
      return result.ok
        ? { text: `Signed in to ${SERVICE_NAMES[service]}.` }
        : { text: result.reason, tone: "problem" };
    });
  };

  const setAdminPassword = (password: string) =>
    act("admin", async () => {
      await call("setAdminPassword", { password });
      setAdminDraft("");
      await reload();
      return {
        text: password
          ? "Saved. Phones signed in as admins must sign in again."
          : "Cleared. No phone can be an admin now.",
      };
    });

  // Not in the chain: it can take minutes.
  const updateTools = async () => {
    setUpdatingTools(true);
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
      say("tools", {
        text: String((err as Error)?.message ?? err),
        tone: "problem",
      });
    } finally {
      setUpdatingTools(false);
    }
  };

  const exportConfig = () =>
    act("config", async () => {
      const { yaml } = await call("exportConfig", {});
      const saved = await window.karafriends.saveTextFile(
        "karafriends-config.yaml",
        yaml,
      );
      return saved ? { text: "Exported." } : null;
    });

  const importConfig = () =>
    act("config", async () => {
      const yaml = await window.karafriends.openTextFile();
      if (yaml === null) return null;
      const result = await call("importConfig", { yaml });
      await reload();
      return result.ok
        ? { text: "Imported.", list: result.problems }
        : {
            text: "Not imported: nothing changed.",
            list: result.problems,
            tone: "problem",
          };
    });

  const header = (
    <header className="settingsHeader">
      <h1>Settings</h1>
      <button type="button" className="kfButton" onClick={props.onClose}>
        Close
      </button>
    </header>
  );

  if (!loaded) {
    return (
      <div className="settings" role="dialog" aria-label="Settings">
        {header}
        <p className="settingsLoading">
          {loadProblem
            ? `Couldn't load the settings: ${loadProblem}`
            : "Loading settings…"}
        </p>
      </div>
    );
  }

  const { settings } = loaded;

  const loginSection = (service: LoginService) => {
    const [userKey, passKey, userLabel] =
      service === "dam"
        ? (["damUsername", "damPassword", "Username"] as const)
        : (["joysoundEmail", "joysoundPassword", "Email"] as const);
    return (
      <SettingsSection
        title={`${SERVICE_NAMES[service]} login`}
        message={messages[service] ?? undefined}
      >
        <div className="settingsFields">
          <TextSetting
            label={userLabel}
            value={settings[userKey]}
            onCommit={(value) => save(service, { [userKey]: value })}
          />
          <TextSetting
            label="Password"
            type="password"
            value={settings[passKey]}
            onCommit={(value) => save(service, { [passKey]: value })}
          />
        </div>
        <div className="settingsActions">
          <button
            type="button"
            className="kfButton"
            onClick={() => testLogin(service)}
          >
            Test login
          </button>
        </div>
      </SettingsSection>
    );
  };

  return (
    <div className="settings" role="dialog" aria-label="Settings">
      {header}
      <div className="settingsBody">
        {loaded.isFirstRun ? (
          <p className="settingsBanner">
            Add your DAM or Joysound login to search their catalogs. YouTube
            works without one.
          </p>
        ) : null}

        {loginSection("dam")}
        {loginSection("joysound")}

        <SettingsSection
          title="Admin password"
          message={messages.admin ?? undefined}
        >
          <p className="settingsNote">
            {settings.adminPasswordSet
              ? "Phones that sign in with it can reorder, skip and remove any song."
              : "None set: no phone can be an admin."}
          </p>
          <form
            className="settingsInline"
            onSubmit={(event) => {
              event.preventDefault();
              if (adminDraft) setAdminPassword(adminDraft);
            }}
          >
            <label className="kfLabel">
              {settings.adminPasswordSet ? "New password" : "Password"}
              <input
                className="kfField"
                type="password"
                autoComplete="new-password"
                value={adminDraft}
                onChange={(event) => setAdminDraft(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="kfButton primary"
              disabled={adminDraft === ""}
            >
              {settings.adminPasswordSet ? "Change password" : "Set password"}
            </button>
            {settings.adminPasswordSet ? (
              <button
                type="button"
                className="kfButton"
                onClick={() => setAdminPassword("")}
              >
                Clear
              </button>
            ) : null}
          </form>
        </SettingsSection>

        <SettingsSection title="Queue" message={messages.queue ?? undefined}>
          <Checkbox
            label="Supervised mode: only a song's singer or an admin can pause, skip or remove it"
            checked={settings.supervisedMode}
            onChange={(checked) => save("queue", { supervisedMode: checked })}
          />
          <Checkbox
            label="Everyone is an admin: any phone can change the queue and playback, no password needed."
            checked={settings.everyoneIsAdmin}
            onChange={(checked) => save("queue", { everyoneIsAdmin: checked })}
          />
          <div className="settingsFields">
            <TextSetting
              label="Songs each phone may queue at once (0: no limit)"
              type="number"
              value={String(settings.paxSongQueueLimit)}
              onCommit={(value) =>
                saveNumber(
                  "queue",
                  "paxSongQueueLimit",
                  "Songs each phone",
                  value,
                )
              }
            />
          </div>
          <Checkbox
            label="Stream DAM songs at a low bitrate"
            checked={settings.useLowBitrateUrl}
            onChange={(checked) => save("queue", { useLowBitrateUrl: checked })}
          />
        </SettingsSection>

        <SettingsSection
          title="Remote port"
          message={messages.network ?? undefined}
        >
          <p className="settingsNote">
            A new port takes effect when karafriends restarts.
          </p>
          <div className="settingsFields">
            <TextSetting
              label="Port for phones"
              type="number"
              value={String(settings.remoconPort)}
              onCommit={(value) =>
                saveNumber("network", "remoconPort", "Port for phones", value)
              }
            />
          </div>
          {loaded.needsRestart ? (
            <div className="settingsRestart">
              <p>Restart karafriends to use the new port.</p>
              <button
                type="button"
                className="kfButton primary"
                onClick={() =>
                  act("network", async () => {
                    await call("restartApp", {});
                    return { text: "Restarting…", tone: "busy" };
                  })
                }
              >
                Restart
              </button>
            </div>
          ) : null}
        </SettingsSection>

        <SettingsSection title="QR code address">
          <p className="settingsNote">
            Pick the address phones on this network can reach.
          </p>
          <HostnameSetting
            hostname={props.hostname}
            onChange={props.onHostnameChange}
          />
        </SettingsSection>

        <SettingsSection title="Display">
          <div className="settingsFields">
            <label className="kfLabel">
              Audio/video offset
              <select
                className="kfField"
                value={props.avOffsetMs}
                onChange={(event) =>
                  props.onAvOffsetChange(Number(event.target.value))
                }
              >
                {AV_OFFSETS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms > 0 ? `+${ms}` : ms} ms
                  </option>
                ))}
              </select>
            </label>
            <label className="kfLabel">
              UI scale
              <select
                className="kfField"
                value={props.uiScale}
                onChange={(event) =>
                  props.onUiScaleChange(Number(event.target.value))
                }
              >
                {UI_SCALES.map((percent) => (
                  <option key={percent} value={percent}>
                    {percent}%
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="settingsNote">
            A plus offset delays the sound, a minus one the Joysound lyrics and
            the piano roll. DAM's lyrics are in the video, and YouTube captions
            and ad-hoc lyrics don't move.
          </p>
          <p className="settingsNote">
            Measured audio output latency: {props.audioLatencyMs} ms
          </p>
        </SettingsSection>

        <DownloadsSection />

        <SettingsSection title="Microphones">
          <MicOutputSetting
            outputs={outputs}
            output={props.micOutput}
            onChange={props.onMicOutputChange}
          />
          <p className="settingsNote">{linux ? linux.status : asio}</p>
          {outputNote ? (
            <p className="settingsNote" role="status">
              {outputNote}
            </p>
          ) : null}
          {linux ? (
            <p className="settingsNote">
              Every mic plays through this output; songs keep playing through
              the system default.
            </p>
          ) : (
            <p className="settingsNote">
              Every mic plays through this output; songs keep playing through
              the system default. An ASIO interface whose driver allows one
              program at a time can't play the songs and the mics at once
              (FlexASIO, ASIO4ALL, RME and MOTU drivers share; many others
              don't).
            </p>
          )}
          <MicModeSetting
            mode={props.micMode}
            linux={linux}
            onChange={props.onMicModeChange}
          />
          {props.mics.map((mic, i) => (
            <MicrophoneSetting
              key={mic.deviceId}
              mic={mic}
              levels={props.micLevels(mic)}
              onChange={(name, channel) => props.onChangeMic(i, name, channel)}
              onLevelsChange={(levels) => props.onChangeLevels(mic, levels)}
              onRemove={() => props.onRemoveMic(i)}
            />
          ))}
          <AddMicrophone
            onAdd={(name, channel) =>
              props.onChangeMic(props.mics.length, name, channel)
            }
          />
        </SettingsSection>

        <SettingsSection title="Tools" message={messages.tools ?? undefined}>
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
              disabled={updatingTools}
              onClick={updateTools}
            >
              {updatingTools ? "Updating tools…" : "Update tools"}
            </button>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Config file"
          message={messages.config ?? undefined}
        >
          <p className="settingsNote">
            Everything on this screen, logins and passwords included.
          </p>
          <div className="settingsActions">
            <button type="button" className="kfButton" onClick={exportConfig}>
              Export config
            </button>
            <button type="button" className="kfButton" onClick={importConfig}>
              Import config
            </button>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
