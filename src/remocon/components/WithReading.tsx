import classnames from "classnames";
import React from "react";

import useReadings from "../hooks/useReadings";
import { reading } from "../readings";
import * as styles from "./WithReading.module.scss";

interface Props {
  text: string;
  // The kana reading, where the catalog gives one (DAM).
  yomi?: string;
  // On a line of its own under the text (a row's title), rather than
  // after it (an artist, on the row's muted line).
  under?: boolean;
}

// A title or an artist's name, with its reading as the phone's Readings
// setting asks.
const WithReading = ({ text, yomi, under = false }: Props) => {
  const extra = reading(text, yomi, useReadings());
  if (extra === null) return <>{text}</>;
  if (!under) return <>{`${text} ${extra}`}</>;
  return (
    <>
      <span className={styles.line}>{text}</span>
      <span className={classnames(styles.line, styles.under)}>{extra}</span>
    </>
  );
};

export default WithReading;
