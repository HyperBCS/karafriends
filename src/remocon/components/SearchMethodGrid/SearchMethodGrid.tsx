import React from "react";

import * as styles from "./SearchMethodGrid.module.scss";
import SearchMethodGridItem from "./SearchMethodGridItem";
import { t } from "../../i18n";

const SearchMethodGrid = () => (
  <div>
    <h2>{t("search.heading")}</h2>
    <div className={styles.grid}>
      <SearchMethodGridItem
        method="joysoundSong"
        text={t("search.titleJoysound")}
      />
      <SearchMethodGridItem
        method="joysoundArtist"
        text={t("search.artistJoysound")}
      />
      <SearchMethodGridItem method="song" text={t("search.titleDam")} />
      <SearchMethodGridItem method="artist" text={t("search.artistDam")} />
      <SearchMethodGridItem method="youtube" text={t("source.youtube")} />
      <SearchMethodGridItem method="niconico" text={t("source.niconico")} />
    </div>
  </div>
);

export default SearchMethodGrid;
