import classnames from "classnames";
import React, { useId } from "react";

import { t } from "../../i18n";
import { FaAngleDown, FaAngleUp } from "../../icons";
import * as styles from "./Sheet.module.scss";

interface Props {
  // Names the sheet for screen readers.
  label: string;
  // The row that always shows: the current song and its singer. It's
  // inside the toggle, a <button>, so it's text and <span>s only.
  header: React.ReactNode;
  // What expanding shows: the queue, the controls.
  children: React.ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  className?: string;
}

// The now-playing panel at the bottom of the remote: a header row that is
// the toggle, one button from edge to edge, with an arrow at its end as the
// cue ("Show queue", "Hide queue"), and a body below it that the toggle
// shows and hides. It doesn't position itself; the app's layout puts it at
// the bottom.
export const Sheet = ({
  label,
  header,
  children,
  expanded,
  onExpandedChange,
  className,
}: Props) => {
  const bodyId = useId();

  return (
    <section aria-label={label} className={classnames(styles.sheet, className)}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => onExpandedChange(!expanded)}
      >
        <span className={styles.headerContent}>{header}</span>
        <span
          role="img"
          className={styles.arrow}
          aria-label={expanded ? t("sheet.hideQueue") : t("sheet.showQueue")}
        >
          {expanded ? <FaAngleDown /> : <FaAngleUp />}
        </span>
      </button>
      <div id={bodyId} className={styles.body} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
};
