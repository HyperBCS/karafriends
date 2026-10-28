import classnames from "classnames";
import React, { useId } from "react";

import { t } from "../../i18n";
import { FaAngleDown, FaAngleUp } from "../../icons";
import { IconButton } from "./Button";
import * as styles from "./Sheet.module.scss";

interface Props {
  // Names the sheet for screen readers.
  label: string;
  // The row that always shows: the current song and its singer.
  header: React.ReactNode;
  // What expanding shows: the queue, the controls.
  children: React.ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  className?: string;
}

// The now-playing panel at the bottom of the remote: a header row with a
// toggle ("Show queue", "Hide queue"), and a body below it that the toggle
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
      <div className={styles.header}>
        <div className={styles.headerContent}>{header}</div>
        <IconButton
          label={expanded ? t("sheet.hideQueue") : t("sheet.showQueue")}
          icon={expanded ? <FaAngleDown /> : <FaAngleUp />}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onExpandedChange(!expanded)}
        />
      </div>
      <div id={bodyId} className={styles.body} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
};
