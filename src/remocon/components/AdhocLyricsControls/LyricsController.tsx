import React from "react";
import { CgTapSingle } from "react-icons/cg";

import * as styles from "./AdhocLyricsControls.module.scss";

interface Props {
  onSendLine: () => void;
}

const LyricsController = ({ onSendLine }: Props) => {
  return (
    <div className={styles.controller} onClick={onSendLine}>
      <div>
        <strong>TAP HERE</strong> <CgTapSingle /> to send lyrics.
      </div>
    </div>
  );
};

export default LyricsController;
