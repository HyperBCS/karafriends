import React, { useEffect, useRef } from "react";
import YouTubePlayer from "youtube-player";

import * as styles from "../pages/SongPage.module.scss";

// A YouTube player for a video's page, so the guest can check it's the
// right one. The player (YouTube's iframe API) is made in an element of its
// own, and destroyed with its listeners when the page goes.
const YouTubeEmbed = ({ videoId }: { videoId: string }) => {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = document.createElement("div");
    box.current!.append(element);
    const player = YouTubePlayer(element, { videoId });
    return () => {
      void player.destroy();
      element.remove();
    };
  }, [videoId]);
  return <div ref={box} className={styles.video} />;
};

export default YouTubeEmbed;
