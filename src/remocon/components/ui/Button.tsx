import classnames from "classnames";
import React from "react";
import { Link } from "react-router";

import * as styles from "./Button.module.scss";

export type ButtonVariant = "primary" | "secondary";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  // primary: the one main action on a screen (accent). secondary: any other
  // action.
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
  // filled: the main control, a raised accent circle (play). muted: a
  // quieter one beside it (restart, skip). danger: removes.
  tone?: "default" | "filled" | "muted" | "danger";
}

// A 44px square button with a 28px icon and no text. aria-disabled: a
// control the server would refuse, dimmed but still focusable; no press of
// it does anything, from a finger, the keyboard or a screen reader.
export const IconButton = ({
  label,
  icon,
  tone = "default",
  className,
  type = "button",
  onClick,
  ...rest
}: IconButtonProps) => (
  <button
    type={type}
    aria-label={label}
    onClick={(e) => {
      if (rest["aria-disabled"] === true || rest["aria-disabled"] === "true") {
        e.preventDefault();
        return;
      }
      onClick?.(e);
    }}
    className={classnames(
      styles.iconButton,
      {
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

export interface IconLinkProps {
  // Where it goes, for screen readers (and the e2e tests): "Song page".
  label: string;
  icon: React.ReactNode;
  // A page in the remote, and what the link tells it (router state).
  to: string;
  state?: unknown;
  onClick?: () => void;
}

// An IconButton that goes to a page in the remote: a router <Link> that
// looks like one.
export const IconLink = ({
  label,
  icon,
  to,
  state,
  onClick,
}: IconLinkProps) => (
  <Link
    to={to}
    state={state}
    aria-label={label}
    className={styles.iconButton}
    onClick={onClick}
  >
    <span aria-hidden="true">{icon}</span>
  </Link>
);
