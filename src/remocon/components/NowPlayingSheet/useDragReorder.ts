import type React from "react";
import { useRef } from "react";

// Where a dragged row lands, given its middle now (y) and its height: past
// each other row whose middle its leading edge has crossed (its top edge
// for the rows above where it started, its bottom edge for those below),
// so a row swaps with a neighbour halfway over it. middles are the rows'
// middles when the drag started, top to bottom; the dragged row's own (at
// from) is left out, since it's the one moving.
export function dropIndex(
  y: number,
  height: number,
  middles: number[],
  from: number,
): number {
  let to = 0;
  middles.forEach((middle, i) => {
    if (
      i < from ? middle < y - height / 2 : i > from && middle < y + height / 2
    )
      to++;
  });
  return to;
}

// How far row i slides to make room while the row at from is held over
// to: the rows in between move up or down by the dragged row's height.
export function slideOf(
  i: number,
  from: number,
  to: number,
  height: number,
): number {
  if (from < i && i <= to) return -height;
  if (to <= i && i < from) return height;
  return 0;
}

interface Drag {
  pointerId: number;
  from: number;
  to: number;
  startY: number;
  rows: HTMLElement[];
  middles: number[];
  height: number;
}

// Drag-to-reorder for a list's rows by a handle in each, with pointer
// events (touch, pen and mouse alike) and no library. handleProps(index)
// goes on row index's handle, a <button> inside the row's <li>; the rows
// are the <li>s of that list holding a handle, in order. While a row is
// held, it follows the pointer and the others slide apart (the transforms
// are set here, the transitions in CSS: the list has data-reordering and
// the held row data-dragging). Letting go calls onMove(from, to) if the
// row would land elsewhere; a cancelled pointer puts everything back.
// Arrow Up and Down on a focused handle move its row by one.
export default function useDragReorder(
  count: number,
  onMove: (from: number, to: number) => void,
) {
  const drag = useRef<Drag | null>(null);

  const place = (d: Drag, dy: number) =>
    d.rows.forEach((row, i) => {
      const y = i === d.from ? dy : slideOf(i, d.from, d.to, d.height);
      row.style.transform = y ? `translateY(${y}px)` : "";
    });

  // Back to the rows' own places, at once (no transition), so the reordered
  // list that onMove renders doesn't slide in from the old places.
  const end = (d: Drag, drop: boolean) => {
    drag.current = null;
    delete d.rows[d.from].parentElement?.dataset.reordering;
    delete d.rows[d.from].dataset.dragging;
    d.rows.forEach((row) => (row.style.transform = ""));
    if (drop && d.to !== d.from) onMove(d.from, d.to);
  };

  const ownDrag = (e: React.PointerEvent) =>
    drag.current?.pointerId === e.pointerId ? drag.current : null;

  return (index: number) => ({
    "data-drag-handle": true,
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (drag.current || e.button !== 0) return;
      const row = e.currentTarget.closest("li");
      const list = row?.parentElement;
      if (!row || !list) return;
      const rows = Array.from(
        list.querySelectorAll("[data-drag-handle]"),
        (handle) => handle.closest("li")!,
      );
      const rects = rows.map((r) => r.getBoundingClientRect());
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = {
        pointerId: e.pointerId,
        from: index,
        to: index,
        startY: e.clientY,
        rows,
        middles: rects.map((r) => (r.top + r.bottom) / 2),
        height: rects[index].height,
      };
      list.dataset.reordering = "";
      row.dataset.dragging = "";
    },
    onPointerMove(e: React.PointerEvent) {
      const d = ownDrag(e);
      if (!d) return;
      const dy = e.clientY - d.startY;
      d.to = dropIndex(d.middles[d.from] + dy, d.height, d.middles, d.from);
      place(d, dy);
    },
    onPointerUp(e: React.PointerEvent) {
      const d = ownDrag(e);
      if (d) end(d, true);
    },
    onPointerCancel(e: React.PointerEvent) {
      const d = ownDrag(e);
      if (d) end(d, false);
    },
    onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
      const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      const to = index + step;
      if (to < 0 || to >= count) return;
      // React may move this row's <li> to its new place, which drops the
      // focus; the handle is the same element there, so focus it again.
      const handle = e.currentTarget;
      onMove(index, to);
      requestAnimationFrame(() => handle.focus());
    },
  });
}
