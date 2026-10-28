import React, { useState } from "react";

import { useApiQuery } from "../../common/apiQueries";
import { t } from "../i18n";
import { reasonText } from "../i18n/reasons";
import * as styles from "../pages/SongPage.module.scss";
import { withLoader } from "./Loader";
import { QueueButton } from "./QueueButtons";
import { InlineError } from "./ui";
import VideoMetadata from "./VideoMetadata";
import YouTubeEmbed from "./YouTubeEmbed";

interface Props {
  videoId: string;
}

// A YouTube video: a player to check it's the right one, its details, the
// lyrics to show with it (its captions, or lyrics pasted here to send line
// by line), and its queue button.
const YouTubeInfo = ({ videoId }: Props) => {
  const [adhocLyrics, setAdhocLyrics] = useState<string | null>(null);
  const [caption, setCaption] = useState("");

  const videoInfo = useApiQuery("youtubeInfo", { videoId });

  return (
    <>
      <YouTubeEmbed videoId={videoId} />
      {!videoInfo.ok && (
        <InlineError>
          {t("video.infoFailed", { reason: reasonText(videoInfo.reason) })}
        </InlineError>
      )}
      {videoInfo.ok && (
        <>
          <VideoMetadata videoSource="youtube" videoInfo={videoInfo.info} />
          <QueueButton
            label={t("queueButton.video")}
            song={{
              kind: "youtube",
              songId: videoId,
              name: videoInfo.info.title,
              artistName: videoInfo.info.author,
              playtime: videoInfo.info.lengthSeconds,
              adhocLyrics,
              captionCode: caption || null,
              gainValue: videoInfo.info.gainValue,
            }}
          />
          <section className={styles.section} aria-label={t("lyrics.heading")}>
            <h3 className={styles.sectionTitle}>{t("lyrics.heading")}</h3>
            <label className={styles.label}>
              {t("lyrics.captions")}
              <select
                className={styles.select}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
              >
                <option value="">{t("lyrics.noCaptions")}</option>
                {videoInfo.info.captionLanguages.map(({ code, name }) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.label}>
              {t("lyrics.adhoc")}
              <textarea
                className={styles.textarea}
                onChange={(e) => setAdhocLyrics(e.target.value.trim() || null)}
                placeholder={t("lyrics.adhocPlaceholder")}
              />
            </label>
            <p className={styles.note}>{t("lyrics.adhocHelp")}</p>
          </section>
        </>
      )}
    </>
  );
};

export default withLoader(YouTubeInfo);
