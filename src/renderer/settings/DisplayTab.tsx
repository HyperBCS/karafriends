import React from "react";

import { UI_SCALES } from "../playback";
import { Checkbox, SettingsSection } from "./controls";

// What the Display tab shows and changes, from App.
export interface DisplayProps {
  uiScale: number;
  onUiScaleChange: (scale: number) => void;
  pitchBars: boolean;
  onPitchBarsChange: (on: boolean) => void;
}

// The UI scale and the pitch bars, kept on the display.
export default function DisplayTab(props: DisplayProps) {
  return (
    <SettingsSection title="Display">
      <div className="settingsFields">
        <label className="kfLabel">
          UI scale
          <select
            className="kfField"
            value={props.uiScale}
            onChange={(event) =>
              props.onUiScaleChange(Number(event.target.value))
            }
          >
            {UI_SCALES.map((percent) => (
              <option key={percent} value={percent}>
                {percent}%
              </option>
            ))}
          </select>
        </label>
      </div>
      <Checkbox
        label="Pitch bars"
        hint="Shows the melody and the singer's pitch on DAM and Joysound songs."
        checked={props.pitchBars}
        onChange={async (on) => {
          props.onPitchBarsChange(on);
          return true;
        }}
      />
    </SettingsSection>
  );
}
