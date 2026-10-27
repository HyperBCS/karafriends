import React from "react";

import { t } from "../../i18n";
import * as styles from "./AdhocLyricsControls.module.scss";

interface Props {
  onSendLine: () => void;
}

// The big target that shows the next line on the display.
const LyricsController = ({ onSendLine }: Props) => (
  <button type="button" className={styles.controller} onClick={onSendLine}>
    {t("lyrics.sendLine")}
  </button>
);

export default LyricsController;
