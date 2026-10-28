import React, { useEffect, useRef, useState } from "react";

import { useApiMutation } from "../../../common/apiQueries";
import { getItem, setItem } from "../../../common/storage";
import { t } from "../../i18n";
import { MdEdit } from "../../icons";
import { IconButton } from "../ui";
import { emojisIn } from "./emotes";
import * as styles from "./NowPlayingSheet.module.scss";

const DEFAULT_EMOTES = ["🆓", "🔥", "❤️"];
const EMOTES_KEY = "emotes";

// The phone's own list, or the defaults.
function savedEmotes(): string[] {
  try {
    const saved: unknown = JSON.parse(getItem(EMOTES_KEY) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.length > 0 &&
      saved.every((emote) => typeof emote === "string")
    ) {
      return saved;
    }
  } catch {
    // Not JSON: the defaults.
  }
  return DEFAULT_EMOTES;
}

// Emotes that float up the display, sent again and again while held. The
// phone keeps its own list.
const EmoteButtons = () => {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [emotes, setEmotes] = useState(savedEmotes);
  // Sent again every 200 ms while held, so sent ones needn't be kept.
  const { mutate: sendEmote } = useApiMutation("sendEmote", {
    gcTime: 0,
    onError: (err) => console.warn("Couldn't send the emote:", err),
  });

  const endEmotes = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
  };

  const startEmotes = (emote: string) => {
    endEmotes();
    sendEmote({ emote });
    intervalRef.current = setInterval(() => sendEmote({ emote }), 200);
  };

  // Stop if the buttons go away while one is held.
  useEffect(() => endEmotes, []);

  const editEmotes = () => {
    const input =
      prompt(t("emotes.prompt"), emotes.join("")) || emotes.join("");
    const found = emojisIn(input);
    const next = found.length > 0 ? found : DEFAULT_EMOTES;
    setItem(EMOTES_KEY, JSON.stringify(next));
    setEmotes(next);
  };

  return (
    <div className={styles.emotes}>
      <div className={styles.emoteChips}>
        {emotes.map((emote) => (
          <button
            key={emote}
            type="button"
            className={styles.emote}
            onPointerDown={() => startEmotes(emote)}
            onPointerUp={endEmotes}
            onPointerLeave={endEmotes}
            onPointerCancel={endEmotes}
            onContextMenu={(e) => e.preventDefault()}
          >
            {emote}
          </button>
        ))}
      </div>
      <IconButton
        label={t("emotes.edit")}
        icon={<MdEdit />}
        tone="muted"
        onClick={editEmotes}
      />
    </div>
  );
};

export default EmoteButtons;
