import React from "react";
import { useParams } from "react-router";

import { usePagedApiQuery } from "../../common/apiQueries";
import { withLoader } from "../components/Loader";
import MoreButton from "../components/MoreButton";
import { List, ListRow, Marquee } from "../components/ui";
import WithReading from "../components/WithReading";
import { t } from "../i18n";
import * as styles from "./SongPage.module.scss";

function useDamArtist(id: string) {
  const paged = usePagedApiQuery(
    "damArtist",
    { id },
    (artist) => artist.songs,
    (song) => song.id,
  );
  return {
    name: paged.first.name,
    nameYomi: paged.first.nameYomi as string | undefined,
    songCount: paged.first.songCount as number | null,
    paged,
  };
}

function useJoysoundArtist(id: string) {
  const paged = usePagedApiQuery(
    "joysoundArtistSongs",
    { id },
    (page) => page,
    (song) => song.id,
  );
  return {
    name: paged.items[0]?.artistName ?? "",
    nameYomi: undefined,
    songCount: null,
    paged,
  };
}

const SONG_PAGES = { dam: "/song/", joysound: "/joysoundSong/" };

// A DAM or Joysound artist's songs. (Render it with key={kind}: the kind
// picks the lookup.)
const ArtistPage = ({ kind }: { kind: "dam" | "joysound" }) => {
  const { id } = useParams<{ id: string }>();
  const useArtist = kind === "dam" ? useDamArtist : useJoysoundArtist;
  const { name, nameYomi, songCount, paged } = useArtist(id!);
  const source = t(kind === "dam" ? "source.dam" : "source.joysound");

  return (
    <>
      <div className={styles.page}>
        <div className={styles.about}>
          <h2 className={styles.title}>
            <Marquee>
              <WithReading text={name} yomi={nameYomi} />
            </Marquee>
          </h2>
          <p className={styles.source}>
            {source}
            {songCount !== null &&
              ` · ${t("search.songCount", { count: songCount })}`}
          </p>
        </div>
      </div>
      <List label={t("search.results")}>
        {paged.items.map((song) => (
          <ListRow
            key={song.id}
            title={
              <WithReading
                text={song.name}
                yomi={"nameYomi" in song ? song.nameYomi : undefined}
              />
            }
            source={source}
            to={`${SONG_PAGES[kind]}${song.id}`}
            state={{ artistNameYomi: nameYomi }}
          />
        ))}
      </List>
      <MoreButton paged={paged} />
    </>
  );
};

export default withLoader(ArtistPage);
