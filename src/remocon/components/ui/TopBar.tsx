import classnames from "classnames";
import React from "react";
import { Link } from "react-router";

import { t } from "../../i18n";
import { MdArrowBack } from "../../icons";
import { IconButton } from "./Button";
import { Marquee } from "./Marquee";
import * as styles from "./TopBar.module.scss";

interface Props {
  // The screen's name, the page's one <h1>. It slides if it's too long.
  title: React.ReactNode;
  // A back button: a path in the remote (a link), or what to do (a button).
  // None on the home screen.
  back?: string | (() => void);
  // The History, Settings and Home buttons, or the language control.
  trailing?: React.ReactNode;
  className?: string;
}

// The remote's one header bar: back, title, and trailing controls.
export const TopBar = ({ title, back, trailing, className }: Props) => (
  <div className={classnames(styles.topBar, className)}>
    {typeof back === "string" && (
      <Link to={back} className={styles.back} aria-label={t("common.back")}>
        <MdArrowBack />
      </Link>
    )}
    {typeof back === "function" && (
      <IconButton
        label={t("common.back")}
        icon={<MdArrowBack />}
        onClick={back}
      />
    )}
    <h1 className={styles.title}>
      <Marquee>{title}</Marquee>
    </h1>
    {trailing && <div className={styles.trailing}>{trailing}</div>}
  </div>
);
