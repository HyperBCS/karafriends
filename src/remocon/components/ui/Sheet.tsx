import React, { useId } from "react";

import { t } from "../../i18n";
import { FaAngleDown, FaAngleUp } from "../../icons";
import * as styles from "./Sheet.module.scss";

interface Props {
  // Names the sheet for screen readers.
  label: string;
  // The bar that always shows: the current song and its singer. It sits
  // beside the toggle, not in it: a tap on it goes through to the toggle,
  // except on a link in it, which keeps its own taps.
  header: React.ReactNode;
  // What expanding shows: the queue, the controls.
  children: React.ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

// The now-playing panel at the bottom of the remote, lifted over the
// screen: a bar with a grab handle on top, and a body below it that the
// bar's toggle shows and hides. The toggle is the arrow at the bar's end
// ("Show queue", "Hide queue"), and it takes a tap anywhere on the bar: its
// tap area stretches under the bar's content, which lets taps through to
// it. A link in the content is beside the toggle, not nested in it, and
// stays above it. The sheet doesn't position itself; the app's layout puts
// it at the bottom.
export const Sheet = ({
  label,
  header,
  children,
  expanded,
  onExpandedChange,
}: Props) => {
  const bodyId = useId();

  return (
    <section aria-label={label} className={styles.sheet}>
      <div className={styles.bar}>
        <div className={styles.barContent}>{header}</div>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? t("sheet.hideQueue") : t("sheet.showQueue")}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span className={styles.arrow} aria-hidden="true">
            {expanded ? <FaAngleDown /> : <FaAngleUp />}
          </span>
        </button>
      </div>
      <div id={bodyId} className={styles.body} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
};
