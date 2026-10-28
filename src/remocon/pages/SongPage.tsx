import React, { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

import type { JoysoundSongDetail } from "../../common/api";
import { useApiQuery } from "../../common/apiQueries";
import JoysoundYouTubeInfo from "../components/JoysoundYouTubeInfo";
import { withLoader } from "../components/Loader";
import QueueButtons from "../components/QueueButtons";
import { Button, Marquee, TextField } from "../components/ui";
import WithReading from "../components/WithReading";
import useReadings from "../hooks/useReadings";
import { t } from "../i18n";
import { reading } from "../../common/readings";
import songLink, { sourceName } from "../songLink";
import { searchLink } from "./SearchPage";
import * as styles from "./SongPage.module.scss";
import { youtubeVideoId as parseYoutubeVideoId } from "../videoLink";

// What the row that opened a DAM song's page tells it (router state): the
// artist's reading, which DAM's song details don't give. Opened any other
// way, the artist shows as written.
interface SongPageState {
  artistNameYomi?: string;
}

// A DAM or Joysound song: what the catalog says about it, and its queue
// buttons.
const SongPage = ({ kind }: { kind: "dam" | "joysound" }) => {
  const params = useParams<{ id: string; youtubeVideoId?: string }>();
  const state = useLocation().state as SongPageState | null;
  const song = useApiQuery(kind === "dam" ? "damSong" : "joysoundSong", {
    id: params.id!,
  });
  const dam =
    "vocalTypes" in song
      ? {
          ...song,
          artistNameYomi: song.artistNameYomi || state?.artistNameYomi || "",
        }
      : null;
  const readings = useReadings();
  // Two lines: in kana or romaji, the reading over the title as written;
  // as written, the title over its kana.
  const shown = reading(song.name, dam?.nameYomi, readings);
  const [title, subtitle] =
    shown !== null
      ? [shown, song.name]
      : [song.name, reading(song.name, dam?.nameYomi, "kana")];

  return (
    <div className={styles.page}>
      <div className={styles.about}>
        <h2 className={styles.title}>
          <Marquee>{title}</Marquee>
        </h2>
        {subtitle && <p className={styles.reading}>{subtitle}</p>}
        <Link
          className={styles.artist}
          to={searchLink(song.artistName, "artist", kind)}
        >
          <WithReading
            text={song.artistName}
            yomi={dam?.artistNameYomi || undefined}
          />
        </Link>
        <p className={styles.source}>
          {sourceName(kind)}
          {song.tieUp && ` · ${song.tieUp}`}
        </p>
      </div>
      {song.lyricsPreview && <blockquote>{song.lyricsPreview} …</blockquote>}
      {dam ? (
        <QueueButtons kind="dam" song={dam} />
      ) : (
        // App.tsx keys the page by the song's id, so another song's page
        // starts without this one's video.
        <JoysoundQueue
          song={song as JoysoundSongDetail}
          initialVideoId={params.youtubeVideoId ?? ""}
        />
      )}
    </div>
  );
};

// Joysound's queue buttons, with an optional YouTube video to play behind
// the lyrics. The video's ID goes in the address, so going back keeps it.
const JoysoundQueue = ({
  song,
  initialVideoId,
}: {
  song: JoysoundSongDetail;
  initialVideoId: string;
}) => {
  const navigate = useNavigate();
  const [videoId, setVideoId] = useState(initialVideoId);
  // Set once the video's details came back: queueing waits for it.
  const [checkedVideoId, setCheckedVideoId] = useState("");
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState(initialVideoId);

  const chooseVideo = (id: string) => {
    setVideoId(id);
    setCheckedVideoId("");
    // Through the router, which keeps its place in the history (the top
    // bar's back button needs it).
    navigate(
      songLink({ kind: "joysound", songId: song.id, youtubeVideoId: id }),
      { replace: true },
    );
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseYoutubeVideoId(link);
    if (id === null) return;
    chooseVideo(id);
    setEditing(false);
  };

  let background: React.ReactNode;
  if (editing) {
    background = (
      <form className={styles.form} onSubmit={onSubmit}>
        <TextField
          label={t("song.backgroundLink")}
          value={link}
          onValueChange={setLink}
          autoFocus
          clearable
          enterKeyHint="done"
        />
        <div className={styles.formButtons}>
          <Button
            type="submit"
            variant="secondary"
            disabled={parseYoutubeVideoId(link) === null}
          >
            {t("song.useVideo")}
          </Button>
          <Button variant="secondary" onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    );
  } else if (videoId) {
    background = (
      <>
        <JoysoundYouTubeInfo
          videoId={videoId}
          setYoutubeVideoId={setCheckedVideoId}
        />
        <Button variant="secondary" full onClick={() => chooseVideo("")}>
          {t("song.removeBackground")}
        </Button>
      </>
    );
  } else {
    background = (
      <Button variant="secondary" full onClick={() => setEditing(true)}>
        {t("song.addBackground")}
      </Button>
    );
  }

  return (
    <>
      <QueueButtons
        kind="joysound"
        song={song}
        youtubeVideoId={videoId || null}
        disabled={editing || (videoId !== "" && checkedVideoId !== videoId)}
      />
      <section className={styles.section} aria-label={t("song.background")}>
        <h3 className={styles.sectionTitle}>{t("song.background")}</h3>
        {background}
      </section>
    </>
  );
};

export default withLoader(SongPage);
