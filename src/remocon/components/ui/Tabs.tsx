import classnames from "classnames";
import React, { useRef } from "react";

import * as styles from "./Tabs.module.scss";

export interface Tab<Id extends string> {
  id: Id;
  label: string;
}

interface Props<Id extends string> {
  // Names the group for screen readers: "Search by", "Source".
  label: string;
  tabs: readonly Tab<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  className?: string;
}

// A row of tabs, such as Title/Artist or All/DAM/Joysound. ARIA tabs:
// one tab stop, and the arrow keys (plus Home and End) move the selection.
export function Tabs<Id extends string>({
  label,
  tabs,
  selected,
  onSelect,
  className,
}: Props<Id>) {
  const list = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    onSelect(tab.id);
    list.current
      ?.querySelector<HTMLButtonElement>(`[data-tab="${tab.id}"]`)
      ?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = tabs.findIndex((tab) => tab.id === selected);
    const next = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: tabs.length - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next);
  };

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      className={classnames(styles.tabs, className)}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const isSelected = tab.id === selected;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab={tab.id}
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className={styles.tab}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
