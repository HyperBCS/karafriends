import classnames from "classnames";
import React from "react";

import * as styles from "./Button.module.scss";

export type ButtonVariant = "primary" | "secondary" | "danger";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  // primary: the one main action on a screen (accent). secondary: any other
  // action. danger: removes or stops something.
  variant?: ButtonVariant;
  // As wide as its container.
  full?: boolean;
}

// A text button. A real <button>, type="button" unless it submits a form.
export const Button = ({
  variant = "primary",
  full,
  className,
  type = "button",
  ...rest
}: ButtonProps) => (
  <button
    type={type}
    className={classnames(
      styles.button,
      styles[variant],
      { [styles.full]: full },
      className,
    )}
    {...rest}
  />
);

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  // What it does, for screen readers (and the e2e tests): "Pause", "Skip".
  label: string;
  icon: React.ReactNode;
  // accent: a toggle or the action that matters most in a row of icons.
  // filled: the main control, a raised accent circle (play). muted: a
  // quieter one beside it (restart, skip). danger: removes.
  tone?: "default" | "accent" | "filled" | "muted" | "danger";
}

// A 44px square button with a 28px icon and no text. Pass aria-pressed for
// a toggle; it shows in the accent when on.
export const IconButton = ({
  label,
  icon,
  tone = "default",
  className,
  type = "button",
  ...rest
}: IconButtonProps) => (
  <button
    type={type}
    aria-label={label}
    className={classnames(
      styles.iconButton,
      {
        [styles.accent]: tone === "accent",
        [styles.filled]: tone === "filled",
        [styles.mutedIcon]: tone === "muted",
        [styles.dangerIcon]: tone === "danger",
      },
      className,
    )}
    {...rest}
  >
    <span aria-hidden="true">{icon}</span>
  </button>
);
