import React from "react";
import { useLocation, useParams } from "react-router";

import type { JoysoundSong } from "../../common/api";
import { useApiQuery, usePagedApiQuery } from "../../common/apiQueries";
import { withLoader } from "../components/Loader";
import MoreButton from "../components/MoreButton";
import { List, ListRow } from "../components/ui";
import { countKey, t } from "../i18n";
import songLink, { BROWSE_PAGES, sourceName } from "../songLink";
import * as styles from "./SongPage.module.scss";

// Browse: Joysound's songs to pick from without a search. Its newest songs,
// its genres' most popular, and its featured lists. (Joysound only: DAM
// gives karafriends no such lists.) The top bar shows it while the host
// has a Joysound login.
const BrowsePage = () => {
  const genres = useApiQuery("joysoundGenres", {});
  const features = useApiQuery("joysoundFeatures", {});
  return (
    <div className={styles.page}>
      <section className={styles.browseSection}>
        <h3 className={styles.sectionTitle}>{t("browse.newSongs")}</h3>
        <List label={t("browse.newSongs")}>
          <ListRow
            title={t("browse.newSongsRow")}
            subtitle={t("browse.newSongsNote")}
            to={BROWSE_PAGES.newSongs}
          />
        </List>
      </section>
      <section className={styles.browseSection}>
        <h3 className={styles.sectionTitle}>{t("browse.genres")}</h3>
        <List label={t("browse.genres")}>
          {genres.map((genre) => (
            <ListRow
              key={genre.id}
              title={genre.name}
              to={`${BROWSE_PAGES.genre}/${genre.id}`}
              state={{ name: genre.name }}
            />
          ))}
        </List>
      </section>
      <section className={styles.browseSection}>
        <h3 className={styles.sectionTitle}>{t("browse.featured")}</h3>
        <List label={t("browse.featured")}>
          {features.map((feature) => (
            <ListRow
              key={feature.id}
              title={feature.title}
              subtitle={t(countKey("search.songCount", feature.songCount), {
                count: feature.songCount,
              })}
              to={`${BROWSE_PAGES.feature}/${feature.id}`}
            />
          ))}
        </List>
      </section>
    </div>
  );
};

// A Joysound song's row: its title, its artist, and where it's from.
const SongRow = ({ song }: { song: JoysoundSong }) => (
  <ListRow
    title={song.name}
    subtitle={song.artistName}
    source={sourceName("joysound")}
    to={songLink({ kind: "joysound", songId: song.id })}
  />
);

// A genre's songs, most popular first, or Joysound's newest: a page at a
// time, with More.
const SongListPage = ({ which }: { which: "genre" | "newSongs" }) => {
  const { id } = useParams<{ id: string }>();
  // The genre's name, from the row that opened it.
  const state = useLocation().state as { name?: string } | null;
  const heading =
    which === "genre" ? (state?.name ?? null) : t("browse.newSongsRow");
  const paged = usePagedApiQuery(
    which === "genre" ? "joysoundGenreSongs" : "joysoundNewSongs",
    which === "genre" ? { id: id! } : {},
    (page) => page,
    (song: JoysoundSong) => song.id,
  );
  return (
    <>
      {heading && (
        <div className={styles.page}>
          <h2 className={styles.featureTitle}>{heading}</h2>
        </div>
      )}
      <List label={heading ?? t("search.results")}>
        {paged.items.map((song) => (
          <SongRow key={song.id} song={song} />
        ))}
      </List>
      <MoreButton paged={paged} />
    </>
  );
};

// One featured list: its picture, title and description, then its songs.
const FeaturePage = () => {
  const { id } = useParams<{ id: string }>();
  const feature = useApiQuery("joysoundFeature", { id: id! });
  return (
    <>
      <div className={styles.page}>
        {feature.picture && (
          <FeaturePicture id={feature.id} title={feature.title} />
        )}
        <div className={styles.about}>
          <h2 className={styles.featureTitle}>{feature.title}</h2>
          {feature.description && (
            <p className={styles.source}>{feature.description}</p>
          )}
        </div>
      </div>
      <List label={feature.title}>
        {feature.songs.map((song) => (
          <SongRow key={song.id} song={song} />
        ))}
      </List>
    </>
  );
};

// Through the karaoke PC, as the song pages' pictures. Gone if it doesn't
// load.
const FeaturePicture = ({ id, title }: { id: string; title: string }) => {
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  return (
    <div className={styles.featurePicture}>
      <img
        src={`/api/songPicture/joysoundFeature/${encodeURIComponent(id)}`}
        alt={title}
        onError={() => setFailed(true)}
      />
    </div>
  );
};

export default withLoader(BrowsePage);
export const BrowseSongList = withLoader(SongListPage);
export const BrowseFeature = withLoader(FeaturePage);
