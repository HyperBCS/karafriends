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
  // An icon before the text; it's decoration, the text names the button.
  icon?: React.ReactNode;
}

// A text button. A real <button>, type="button" unless it submits a form.
export const Button = ({
  variant = "primary",
  full,
  icon,
  className,
  type = "button",
  children,
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
  >
    {icon && <span aria-hidden="true">{icon}</span>}
    {children}
  </button>
);

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  // What it does, for screen readers (and the e2e tests): "Pause", "Skip".
  label: string;
  icon: React.ReactNode;
  // accent: the main control in a group, such as play. danger: removes.
  tone?: "default" | "accent" | "danger";
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
        [styles.dangerIcon]: tone === "danger",
      },
      className,
    )}
    {...rest}
  >
    <span aria-hidden="true">{icon}</span>
  </button>
);
