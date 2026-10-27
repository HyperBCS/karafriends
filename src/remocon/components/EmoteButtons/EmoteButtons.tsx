import React, { useEffect, useRef, useState } from "react";
import { MdEdit } from "react-icons/md";

import { useApiMutation } from "../../../common/apiQueries";
import * as styles from "./EmoteButtons.module.scss";

const DEFAULT_EMOTES = ["🆓", "🔥", "❤️"];

const EmoteButtons = () => {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [emotes, setEmotes] = useState<string[]>(
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

  const showEmotesPrompt = () => {
    const input =
      prompt("Enter a list of emojis", emotes.join("")) || emotes.join("");
    const emojis =
      input.match(/\p{Emoji_Presentation}|\p{Emoji}️/gu) || DEFAULT_EMOTES;
    const uniqueEmojis = [...new Set(emojis)];
    localStorage.setItem("emotes", JSON.stringify(uniqueEmojis));
    setEmotes(uniqueEmojis);
  };

  return (
    <div className={styles.emotes}>
      <div className={styles.custom} onClick={() => showEmotesPrompt()}>
        <MdEdit />
      </div>
      {emotes
        .slice()
        .reverse()
        .map((emote) => (
          <div
            key={emote}
            className={styles.emoteItem}
            onMouseDown={() => startEmotes(emote)}
            onMouseLeave={() => endEmotes()}
            onMouseUp={() => endEmotes()}
            onTouchStart={() => startEmotes(emote)}
            onTouchEnd={() => endEmotes()}
          >
            {emote}
          </div>
        ))}
    </div>
  );
};

export default EmoteButtons;
