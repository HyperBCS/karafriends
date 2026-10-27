import classnames from "classnames";
import React from "react";

import usePitchShiftSemis from "../../../common/hooks/usePitchShiftSemis";
import * as styles from "./PitchControls.module.scss";

const PitchControls = (props: { disabled: boolean }) => {
  const { pitchShiftSemis, setPitchShiftSemis } = usePitchShiftSemis();

  return (
    <div
      className={classnames(styles.controls, {
        [styles.disabled]: props.disabled,
      })}
    >
      <div
        className={styles.symbol}
        role="button"
        aria-label="Lower the key"
        aria-disabled={props.disabled}
        onClick={() => setPitchShiftSemis(pitchShiftSemis - 1)}
      >
        ♭
      </div>
      <div className={styles.display} role="status" aria-label="Key">
        {pitchShiftSemis}
      </div>
      <div
        className={styles.symbol}
        role="button"
        aria-label="Raise the key"
        aria-disabled={props.disabled}
        onClick={() => setPitchShiftSemis(pitchShiftSemis + 1)}
      >
        ♯
      </div>
    </div>
  );
};

export default PitchControls;
