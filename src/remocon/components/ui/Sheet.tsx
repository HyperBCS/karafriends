import classnames from "classnames";
import React, { useId, useState } from "react";

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
  // Controlled when given; otherwise the sheet keeps its own state.
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  defaultExpanded?: boolean;
  // The toggle's names; "Show queue" and "Hide queue" unless given.
  expandLabel?: string;
  collapseLabel?: string;
  className?: string;
}

// The now-playing panel at the bottom of the remote: a header row with a
// toggle, and a body below it that the toggle shows and hides. It doesn't
// position itself; the app's layout puts it at the bottom.
export const Sheet = ({
  label,
  header,
  children,
  expanded: controlled,
  onExpandedChange,
  defaultExpanded = false,
  expandLabel = t("sheet.showQueue"),
  collapseLabel = t("sheet.hideQueue"),
  className,
}: Props) => {
  const [own, setOwn] = useState(defaultExpanded);
  const expanded = controlled ?? own;
  const bodyId = useId();

  const toggle = () => {
    setOwn(!expanded);
    onExpandedChange?.(!expanded);
  };

  return (
    <section aria-label={label} className={classnames(styles.sheet, className)}>
      <div className={styles.header}>
        <div className={styles.headerContent}>{header}</div>
        <IconButton
          label={expanded ? collapseLabel : expandLabel}
          icon={expanded ? <FaAngleDown /> : <FaAngleUp />}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={toggle}
        />
      </div>
      <div id={bodyId} className={styles.body} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
};
