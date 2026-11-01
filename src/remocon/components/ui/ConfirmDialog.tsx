import React, { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { t } from "../../i18n";
import { Button } from "./Button";
import * as styles from "./ConfirmDialog.module.scss";

interface Props {
  open: boolean;
  // The question: "Skip this song?"
  title: string;
  // What it's about, under the question: the song.
  children?: React.ReactNode;
  // The button that does it: "Skip".
  confirmLabel: string;
  onConfirm: () => void;
  // Cancel, the Back gesture or Escape, or a tap outside.
  onCancel: () => void;
}

// Asks before an action that can't be taken back (skipping a song, taking
// one off the queue): a card over the dimmed screen, with Cancel and the
// action. A modal <dialog>: nothing behind it takes a tap meanwhile, and
// focus starts on Cancel. In <body>, so it can open from inside a list row
// or the sheet, and a tap in it goes to no row.
export const ConfirmDialog = ({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return createPortal(
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // The parent closes it, by open.
        e.preventDefault();
        onCancel();
      }}
      // The card fills the dialog, so a tap on the dialog itself is on the
      // backdrop around it.
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className={styles.card}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {children && <div className={styles.body}>{children}</div>}
        <div className={styles.buttons}>
          <Button variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
};
