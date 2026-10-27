import React from "react";

import { useApiQuery } from "../../../common/apiQueries";
import { withLoader } from "../Loader";
import VideoMetadata from "../VideoMetadata";
import * as styles from "./NiconicoInfo.module.scss";
import NiconicoQueueButton from "./NiconicoQueueButton";

interface Props {
  videoId: string;
}

const NiconicoInfo = ({ videoId }: Props) => {
  const videoInfo = useApiQuery("nicoInfo", { videoId });

  return (
    <div className={styles.container}>
      {!videoInfo.ok && (
        <div>
          Unable to get video info for the following reason: {videoInfo.reason}
        </div>
      )}
      {videoInfo.ok && (
        <>
          <a href={`https://www.nicovideo.jp/watch/${videoId}`} target="_blank">
            <img src={videoInfo.info.thumbnailUrl} />
          </a>
          <VideoMetadata videoSource="niconico" videoInfo={videoInfo.info} />
          <div className={styles.note}>
            ※ Note that Niconico videos tend to take longer to download. Please
            wait warmly until they are ready.
          </div>
          <NiconicoQueueButton videoId={videoId} videoInfo={videoInfo.info} />
        </>
      )}
    </div>
  );
};

export default withLoader(NiconicoInfo);
