import type React from "react";
import { useCallback, useLayoutEffect, useRef } from "react";

// Where a dragged row lands, given its middle now (y) and its height: past
// each other row whose middle its leading edge has crossed (its top edge
// for the rows above where it started, its bottom edge for those below),
// so a row swaps with a neighbour halfway over it. middles are the rows'
// middles as laid out (without the slides), top to bottom; the dragged
// row's own (at from) is left out, since it's the one moving.
export function dropIndex(
  y: number,
  height: number,
  middles: number[],
  from: number,
): number {
  let to = 0;
  middles.forEach((middle, i) => {
    const edge = i < from ? y - height / 2 : y + height / 2;
    if (i !== from && middle < edge) to++;
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
  // The held row's handle, which has the pointer, and the row: the same
  // elements for as long as the song is in the list (the rows are keyed by
  // song), wherever the list moves it.
  handle: HTMLElement;
  row: HTMLElement;
  list: HTMLElement;
  // The pointer's clientY, and how far below the row's top it took hold.
  y: number;
  grip: number;
  // What scrolls the list (the queue region), and the frame that next
  // scrolls it.
  scroller: HTMLElement | null;
  frame: number;
}

// Within this far of the scroller's top or bottom, a held row scrolls it.
const EDGE = 40;

// The rows with a handle, top to bottom, and a row's top in the list as
// laid out: offsetTop leaves out the transforms set here.
const rowsOf = (list: HTMLElement) =>
  Array.from(
    list.querySelectorAll("[data-drag-handle]"),
    (handle): HTMLElement => handle.closest("li")!,
  );
const topOf = (list: HTMLElement, row: HTMLElement) =>
  row.offsetTop - (row.offsetParent === list ? 0 : list.offsetTop);

function scrollerOf(list: HTMLElement): HTMLElement | null {
  let el = list.parentElement;
  while (el && !/auto|scroll/.test(getComputedStyle(el).overflowY)) {
    el = el.parentElement;
  }
  return el;
}

// Puts the held row under the pointer (but no further than the first and
// last rows) and slides the others out of its way, from where the rows are
// now: the list may have scrolled, or a song ended or gone, meanwhile.
// Returns where the row is, and where it would land.
function place(d: Drag): [from: number, to: number] {
  const rows = rowsOf(d.list);
  const from = rows.indexOf(d.row);
  const tops = rows.map((row) => topOf(d.list, row));
  const middles = rows.map((row, i) => tops[i] + row.offsetHeight / 2);
  const height = d.row.offsetHeight;
  const last = rows.length - 1;
  const top = Math.min(
    Math.max(d.y - d.list.getBoundingClientRect().top - d.grip, tops[0]),
    tops[last] + rows[last].offsetHeight - height,
  );
  const to = dropIndex(top + height / 2, height, middles, from);
  rows.forEach((row, i) => {
    const y = i === from ? top - tops[i] : slideOf(i, from, to, height);
    row.style.transform = y ? `translateY(${y}px)` : "";
  });
  return [from, to];
}

// Every frame while a row is held: with the pointer near the scroller's top
// or bottom (or past it), scrolls toward that end, faster the nearer, and
// the held row along.
function autoScroll(d: Drag) {
  d.frame = requestAnimationFrame(() => autoScroll(d));
  if (!d.scroller) return;
  const { top, bottom } = d.scroller.getBoundingClientRect();
  const up = Math.min(EDGE, top + EDGE - d.y);
  const down = Math.min(EDGE, d.y - bottom + EDGE);
  const before = d.scroller.scrollTop;
  if (up > 0) d.scroller.scrollTop -= Math.ceil(up / 4);
  else if (down > 0) d.scroller.scrollTop += Math.ceil(down / 4);
  if (d.scroller.scrollTop !== before) place(d);
}

// Back to the rows' own places, at once (no transition), so the reordered
// list that a move renders doesn't slide in from the old places.
function settle(d: Drag) {
  cancelAnimationFrame(d.frame);
  delete d.list.dataset.reordering;
  delete d.row.dataset.dragging;
  for (const row of d.list.children) (row as HTMLElement).style.transform = "";
}

// Drag-to-reorder for a list's rows by a handle in each, with pointer
// events (touch, pen and mouse alike) and no library. handleProps(index)
// goes on row index's handle, a <button> inside the row's <li>; the rows
// are the <li>s of that list holding a handle, in order. While a row is
// held, it follows the pointer and the others slide apart (the transforms
// are set here, the transitions in CSS: the list has data-reordering and
// the held row data-dragging). Letting go calls onMove(from, to) if the
// row would land elsewhere; a cancelled pointer puts everything back, as
// does the row leaving the list. Arrow Up and Down on a focused handle
// move its row by one. handleProps is the same function on every render.
export default function useDragReorder(
  count: number,
  onMove: (from: number, to: number) => void,
) {
  const drag = useRef<Drag | null>(null);
  const latest = useRef({ count, onMove });

  // After each render, before it shows: the latest count and onMove for the
  // handlers, and a held row placed in the list as it now is, or let go if
  // it's gone (its song removed, or this phone no longer an admin).
  useLayoutEffect(() => {
    latest.current = { count, onMove };
    const d = drag.current;
    if (d?.handle.isConnected) place(d);
    else if (d) {
      drag.current = null;
      settle(d);
    }
  });

  return useCallback((index: number) => {
    const end = (d: Drag, drop: boolean) => {
      drag.current = null;
      const [from, to] = place(d);
      settle(d);
      if (drop && from >= 0 && to !== from) latest.current.onMove(from, to);
    };
    const ownDrag = (e: React.PointerEvent) =>
      drag.current?.pointerId === e.pointerId ? drag.current : null;

    return {
      "data-drag-handle": true,
      onPointerDown(e: React.PointerEvent<HTMLElement>) {
        if (drag.current || e.button !== 0) return;
        const row = e.currentTarget.closest("li");
        const list = row?.parentElement;
        if (!row || !list) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const top = list.getBoundingClientRect().top + topOf(list, row);
        const d: Drag = {
          pointerId: e.pointerId,
          handle: e.currentTarget,
          row,
          list,
          y: e.clientY,
          grip: e.clientY - top,
          scroller: scrollerOf(list),
          frame: 0,
        };
        drag.current = d;
        list.dataset.reordering = "";
        row.dataset.dragging = "";
        autoScroll(d);
      },
      onPointerMove(e: React.PointerEvent) {
        const d = ownDrag(e);
        if (!d) return;
        d.y = e.clientY;
        place(d);
      },
      onPointerUp(e: React.PointerEvent) {
        const d = ownDrag(e);
        if (d) end(d, true);
      },
      onPointerCancel(e: React.PointerEvent) {
        const d = ownDrag(e);
        if (d) end(d, false);
      },
      // The browser took the pointer away (after an up or a cancel, the
      // drag has already ended).
      onLostPointerCapture(e: React.PointerEvent) {
        const d = ownDrag(e);
        if (d) end(d, false);
      },
      onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
        const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
        if (!step) return;
        e.preventDefault();
        const to = index + step;
        if (to < 0 || to >= latest.current.count) return;
        // React may move this row's <li> to its new place, which drops the
        // focus; the handle is the same element there, so focus it again.
        const handle = e.currentTarget;
        latest.current.onMove(index, to);
        requestAnimationFrame(() => handle.focus());
      },
    };
  }, []);
}
