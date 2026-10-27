import React, { useRef } from "react";

import { useLiveEvent } from "../common/apiClient";
import "./Effects.css";

// Emotes from the phones float up the screen for a second.
const Effects = () => {
  const effectsRef = useRef<HTMLDivElement>(null);

  useLiveEvent("emote", ({ emote }) => {
    const effectsDiv = effectsRef.current;
    if (!effectsDiv) return;
    const emoteDiv = document.createElement("div");
    emoteDiv.textContent = emote;
    emoteDiv.style.left = `${Math.random() * 70 + 10}%`;
    effectsDiv.appendChild(emoteDiv);
    setTimeout(() => emoteDiv.remove(), 1000);
  });

  return <div id="effects" ref={effectsRef} />;
};

export default Effects;
