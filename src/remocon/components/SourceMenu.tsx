import React, { useEffect, useId, useRef, useState } from "react";

import { t } from "../i18n";
import { MdArrowDropDown, MdCheck, MdTune } from "../icons";
import type { SearchSource } from "./SearchResults";
import * as styles from "./SourceMenu.module.scss";

const SOURCES: readonly SearchSource[] = ["all", "dam", "joysound"];

const sourceName = (source: SearchSource) =>
  source === "all" ? t("search.sourceAll") : t(`source.${source}`);

interface Props {
  source: SearchSource;
  onSelect: (source: SearchSource) => void;
}

// The search's source (All, DAM or Joysound) behind a button, in a small
// menu. The button names the source when it isn't All, so a search that
// leaves a catalog out says so. An ARIA menu button: the focus goes into the
// menu, the arrow keys move it, and Escape, Tab, a pick or a tap anywhere
// else closes the menu.
const SourceMenu = ({ source, onSelect }: Props) => {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Closing from inside the menu puts the focus back on the button.
  const close = () => {
    if (menu.current?.contains(document.activeElement)) {
      button.current?.focus();
    }
    setOpen(false);
  };

  // Opened: the focus on the picked source, and a tap outside closes it.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        !menu.current?.contains(target) &&
        !button.current?.contains(target)
      ) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
      return;
    }
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: items.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    items[(next + items.length) % items.length].focus();
  };

  return (
    <div className={styles.sourceMenu}>
      <button
        ref={button}
        type="button"
        className={styles.button}
        aria-label={t("search.sourceButton", { source: sourceName(source) })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={styles.icon} aria-hidden="true">
          <MdTune />
        </span>
        {source !== "all" && sourceName(source)}
        <span className={styles.icon} aria-hidden="true">
          <MdArrowDropDown />
        </span>
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={t("search.sourceLabel")}
          className={styles.menu}
          onKeyDown={onKeyDown}
        >
          {SOURCES.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={id === source}
              tabIndex={-1}
              className={styles.item}
              onClick={() => {
                onSelect(id);
                close();
              }}
            >
              <span className={styles.tick} aria-hidden="true">
                {id === source && <MdCheck />}
              </span>
              {sourceName(id)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default SourceMenu;
