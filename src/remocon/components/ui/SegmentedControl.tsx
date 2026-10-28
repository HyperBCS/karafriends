import classnames from "classnames";
import React, { useId, useRef } from "react";

import { MdCheck } from "../../icons";
import * as styles from "./SegmentedControl.module.scss";

interface Choice<Id extends string> {
  id: Id;
  label: string;
}

interface Props<Id extends string> {
  // Shown above the choices, and read by screen readers: "Theme".
  label: string;
  // When the screen already says what the choice is for (the search's
  // Title and Artist, under the search box).
  hideLabel?: boolean;
  choices: readonly Choice<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  // Small separate chips, lighter than the row: the search's Title and
  // Artist.
  small?: boolean;
  className?: string;
}

// One choice out of a few, such as Light, Dark or Auto: a rounded row with
// the picked one filled in the accent and ticked. ARIA radios: one tab
// stop, and the arrow keys (plus Home and End) move the choice.
export function SegmentedControl<Id extends string>({
  label,
  hideLabel,
  choices,
  selected,
  onSelect,
  small,
  className,
}: Props<Id>) {
  const labelId = useId();
  const group = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    const choice = choices[(index + choices.length) % choices.length];
    onSelect(choice.id);
    group.current
      ?.querySelector<HTMLButtonElement>(`[data-choice="${choice.id}"]`)
      ?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = choices.findIndex((choice) => choice.id === selected);
    const next = {
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      Home: 0,
      End: choices.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next);
  };

  return (
    <div className={classnames(styles.field, className)}>
      {!hideLabel && (
        <span id={labelId} className={styles.label}>
          {label}
        </span>
      )}
      <div
        ref={group}
        role="radiogroup"
        aria-label={hideLabel ? label : undefined}
        aria-labelledby={hideLabel ? undefined : labelId}
        className={small ? styles.chips : styles.row}
        onKeyDown={onKeyDown}
      >
        {choices.map((choice) => {
          const isSelected = choice.id === selected;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              data-choice={choice.id}
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              className={styles.choice}
              onClick={() => onSelect(choice.id)}
            >
              {isSelected && !small && (
                <span className={styles.tick} aria-hidden="true">
                  <MdCheck />
                </span>
              )}
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
