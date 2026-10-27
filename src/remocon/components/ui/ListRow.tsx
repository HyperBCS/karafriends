import classnames from "classnames";
import React from "react";
import { Link } from "react-router";

import * as styles from "./ListRow.module.scss";

interface ListProps {
  // Names the list for screen readers: "Queue", "Search results".
  label?: string;
  className?: string;
  children: React.ReactNode;
}

// A list of ListRows: a <ul>.
export const List = ({ label, className, children }: ListProps) => (
  <ul aria-label={label} className={classnames(styles.list, className)}>
    {children}
  </ul>
);

interface RowContent {
  // One line each; longer text ends in an ellipsis.
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  // Where the song comes from, already translated: "DAM", "YouTube".
  source?: string;
  // Before the text, such as the singer's initial.
  leading?: React.ReactNode;
}

type Press =
  // A page in the remote.
  | { to: string; href?: never; onPress?: never }
  // Somewhere else.
  | { href: string; to?: never; onPress?: never }
  | { onPress: () => void; to?: never; href?: never }
  // Not pressable.
  | { to?: never; href?: never; onPress?: never };

export type ListRowProps = RowContent &
  Press & {
    // After the text, outside the pressable part, so it can hold its own
    // buttons: an ETA, "Remove", "Move to top".
    trailing?: React.ReactNode;
    // The current item (the song playing), in the accent.
    current?: boolean;
    // Replaces the title and subtitle as the pressable part's accessible
    // name.
    "aria-label"?: string;
    className?: string;
  };

const Content = ({ title, subtitle, source, leading }: RowContent) => (
  <>
    {leading && <span className={styles.leading}>{leading}</span>}
    <span className={styles.text}>
      <span className={styles.title}>{title}</span>
      {(subtitle || source) && (
        <span className={styles.subtitleLine}>
          {source && <span className={styles.source}>{source}</span>}
          {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        </span>
      )}
    </span>
  </>
);

// One row of a List: a song, an artist, a queue entry. The row is a <li>;
// its main part is a router <Link> (to), an <a> (href), a <button>
// (onPress) or plain text, and the trailing slot sits beside it, so buttons
// there aren't nested in another control.
export const ListRow = ({
  title,
  subtitle,
  source,
  leading,
  trailing,
  current,
  to,
  href,
  onPress,
  className,
  "aria-label": ariaLabel,
}: ListRowProps) => {
  const content = (
    <Content
      title={title}
      subtitle={subtitle}
      source={source}
      leading={leading}
    />
  );
  // For the current row, says so to screen readers too.
  const currentProps = current ? { "aria-current": true as const } : {};

  let main: React.ReactNode;
  if (to !== undefined) {
    main = (
      <Link
        to={to}
        className={styles.main}
        aria-label={ariaLabel}
        {...currentProps}
      >
        {content}
      </Link>
    );
  } else if (href !== undefined) {
    main = (
      <a
        href={href}
        className={styles.main}
        aria-label={ariaLabel}
        {...currentProps}
      >
        {content}
      </a>
    );
  } else if (onPress) {
    main = (
      <button
        type="button"
        onClick={onPress}
        className={styles.main}
        aria-label={ariaLabel}
        {...currentProps}
      >
        {content}
      </button>
    );
  } else {
    main = (
      <div className={styles.main} {...currentProps}>
        {content}
      </div>
    );
  }

  return (
    <li
      className={classnames(
        styles.row,
        { [styles.current]: current },
        className,
      )}
    >
      {main}
      {trailing && <div className={styles.trailing}>{trailing}</div>}
    </li>
  );
};
