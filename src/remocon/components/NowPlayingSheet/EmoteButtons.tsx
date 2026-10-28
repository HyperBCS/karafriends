import React, { useEffect, useRef, useState } from "react";

import { useApiMutation } from "../../../common/apiQueries";
import { t } from "../../i18n";
import { MdEdit } from "../../icons";
import { IconButton } from "../ui";
import * as styles from "./NowPlayingSheet.module.scss";

const DEFAULT_EMOTES = ["🆓", "🔥", "❤️"];

// Emotes that float up the display, sent again and again while held. The
// phone keeps its own list.
const EmoteButtons = () => {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [emotes, setEmotes] = useState<string[]>(() =>
    JSON.parse(
      localStorage.getItem("emotes") || JSON.stringify(DEFAULT_EMOTES),
    ),
  );
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
    const emojis =
      input.match(/\p{Emoji_Presentation}|\p{Emoji}️/gu) || DEFAULT_EMOTES;
    const uniqueEmojis = [...new Set(emojis)];
    localStorage.setItem("emotes", JSON.stringify(uniqueEmojis));
    setEmotes(uniqueEmojis);
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
