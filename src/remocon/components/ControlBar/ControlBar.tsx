import React, { useState } from "react";

import {
  BsMusicPlayerFill,
  FaAngleDown,
  FaAngleUp,
  FaSmile,
} from "../../icons";
import EmoteButtons from "../EmoteButtons";
import PlaybackControls from "../PlaybackControls";
import SongQueue from "../SongQueue";
import * as styles from "./ControlBar.module.scss";
import NowPlaying from "./NowPlaying";

const ControlBar = () => {
  const [expanded, _setExpanded] = useState(
    localStorage.getItem("expanded") === "true" || false,
  );
  const [showEmotes, _setShowEmotes] = useState(
    localStorage.getItem("showEmotes") === "true" || false,
  );

  const setExpanded = (value: boolean) => {
    localStorage.setItem("expanded", value.toString());
    _setExpanded(value);
  };

  const setShowEmotes = (value: boolean) => {
    localStorage.setItem("showEmotes", value.toString());
    _setShowEmotes(value);
  };

  return (
    <div className={styles.controlBar}>
      <div className={styles.expander}>
        <NowPlaying />
        <div
          role="button"
          aria-label={expanded ? "Hide queue" : "Show queue"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <FaAngleDown /> : <FaAngleUp />}
        </div>
      </div>
      {expanded && (
        <>
          <div className={styles.queue} role="region" aria-label="Queue">
            <SongQueue />
          </div>
          <div
            className={styles.toggle}
            role="button"
            aria-label={showEmotes ? "Show playback controls" : "Show emotes"}
            onClick={() => setShowEmotes(!showEmotes)}
          >
            {showEmotes ? <BsMusicPlayerFill /> : <FaSmile />}
          </div>
          <div className={styles.controls}>
            {showEmotes ? <EmoteButtons /> : <PlaybackControls />}
          </div>
        </>
      )}
    </div>
  );
};

export default ControlBar;
