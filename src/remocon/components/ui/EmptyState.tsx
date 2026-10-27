import classnames from "classnames";
import React from "react";

import * as styles from "./Feedback.module.scss";

interface Props {
  // One line: "The queue is empty", "No results found". No icon.
  children: React.ReactNode;
  className?: string;
}

// What a list shows when it has nothing in it.
export const EmptyState = ({ children, className }: Props) => (
  <p className={classnames(styles.empty, className)}>{children}</p>
);
