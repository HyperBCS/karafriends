import React from "react";

import { useApiQuery } from "../../../common/apiQueries";
import { t } from "../../i18n";
import { reasonText } from "../../i18n/reasons";
import * as styles from "../../pages/SongPage.module.scss";
import { withLoader } from "../Loader";
import { QueueButton } from "../QueueButtons";
import { InlineError } from "../ui";
import VideoMetadata from "../VideoMetadata";

interface Props {
  videoId: string;
}

// A Niconico video: its thumbnail (a link to it), details and queue button.
const NiconicoInfo = ({ videoId }: Props) => {
  const videoInfo = useApiQuery("nicoInfo", { videoId });

  if (!videoInfo.ok) {
    return (
      <InlineError>
        {t("video.infoFailed", { reason: reasonText(videoInfo.reason) })}
      </InlineError>
    );
  }
  const { info } = videoInfo;
  return (
    <>
      <a
        className={styles.video}
        href={`https://www.nicovideo.jp/watch/${videoId}`}
        target="_blank"
        rel="noreferrer"
      >
        <img src={info.thumbnailUrl} alt={info.title} />
      </a>
      <VideoMetadata videoSource="niconico" videoInfo={info} />
      <QueueButton
        label={t("queueButton.video")}
        song={{
          kind: "nico",
          songId: videoId,
          name: info.title,
          artistName: info.author,
          playtime: info.lengthSeconds,
        }}
      />
      <p className={styles.note}>{t("video.niconicoSlow")}</p>
    </>
  );
};

export default withLoader(NiconicoInfo);
