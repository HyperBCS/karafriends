import classnames from "classnames";
import React, { useId, useRef } from "react";

import { t } from "../../i18n";
import { MdClose } from "../../icons";
import { IconButton } from "./Button";
import * as styles from "./TextField.module.scss";

export interface TextFieldProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "defaultValue" | "size"
> {
  // Always given, and read by screen readers; shown unless hideLabel.
  label: string;
  // When the screen already says what the field is for (a search box under
  // a "Search" title).
  hideLabel?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  // A clear button inside the field while it has text.
  clearable?: boolean;
  // An icon at the start, such as a magnifier. Decoration only.
  icon?: React.ReactNode;
}

// A labelled one-line text input, controlled through value/onValueChange.
export const TextField = ({
  label,
  hideLabel,
  value,
  onValueChange,
  clearable,
  icon,
  className,
  id,
  type = "text",
  ...rest
}: TextFieldProps) => {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className={classnames(styles.field, className)}>
      <label
        htmlFor={inputId}
        className={hideLabel ? styles.visuallyHidden : styles.label}
      >
        {label}
      </label>
      <div className={styles.box}>
        {icon && (
          <span className={styles.leading} aria-hidden="true">
            {icon}
          </span>
        )}
        <input
          ref={input}
          id={inputId}
          type={type}
          className={styles.input}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          {...rest}
        />
        {clearable && value !== "" && (
          <IconButton
            label={t("common.clear")}
            icon={<MdClose />}
            // Keeps the focus (and the keyboard) in the field: clearing it
            // isn't leaving it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onValueChange("");
              input.current?.focus();
            }}
          />
        )}
      </div>
    </div>
  );
};
