import React from "react";

import { t } from "../i18n";
import { MdArrowDropDown, MdTune } from "../icons";
import type { SearchSource } from "./SearchResults";
import * as styles from "./SourceMenu.module.scss";

const SOURCES: readonly SearchSource[] = ["all", "dam", "joysound"];

const sourceName = (source: SearchSource) =>
  source === "all" ? t("search.sourceAll") : t(`source.${source}`);

interface Props {
  source: SearchSource;
  onSelect: (source: SearchSource) => void;
}

// The search's source (All, DAM or Joysound), behind a small button that
// names the source when it isn't All, so a search that leaves a catalog out
// says so. The button is a native <select> laid over it, unseen: a tap opens
// the phone's own picker, with the keyboard, focus and dismissal it brings.
const SourceMenu = ({ source, onSelect }: Props) => (
  <div className={styles.sourceMenu}>
    <span className={styles.icon} aria-hidden="true">
      <MdTune />
    </span>
    {source !== "all" && <span aria-hidden="true">{sourceName(source)}</span>}
    <span className={styles.icon} aria-hidden="true">
      <MdArrowDropDown />
    </span>
    <select
      className={styles.select}
      aria-label={t("search.sourceLabel")}
      value={source}
      onChange={(e) => onSelect(e.target.value as SearchSource)}
    >
      {SOURCES.map((id) => (
        <option key={id} value={id}>
          {sourceName(id)}
        </option>
      ))}
    </select>
  </div>
);

export default SourceMenu;
