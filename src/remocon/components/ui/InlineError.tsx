import classnames from "classnames";
import React from "react";

import { t } from "../../i18n";
import { Button } from "./Button";
import * as styles from "./Feedback.module.scss";

interface Props {
  // What happened and what to do: "Couldn't download. Try another video."
  children: React.ReactNode;
  // A "Try again" button, when trying again might work.
  onRetry?: () => void;
  className?: string;
}

// An error in place of what failed to show, announced when it appears.
export const InlineError = ({ children, onRetry, className }: Props) => (
  <div role="alert" className={classnames(styles.error, className)}>
    <p className={styles.errorText}>{children}</p>
    {onRetry && (
      <Button variant="secondary" onClick={onRetry}>
        {t("common.tryAgain")}
      </Button>
    )}
  </div>
);
