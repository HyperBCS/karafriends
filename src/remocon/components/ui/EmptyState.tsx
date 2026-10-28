import React from "react";

import * as styles from "./Feedback.module.scss";

interface Props {
  // One line: "The queue is empty", "No results found". No icon.
  children: React.ReactNode;
}

// What a list shows when it has nothing in it.
export const EmptyState = ({ children }: Props) => (
  <p className={styles.empty}>{children}</p>
);
