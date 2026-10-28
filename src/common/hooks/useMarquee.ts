import { useLayoutEffect, useRef } from "react";

// A line of text that doesn't fit its box (a song's title or artist) slides
// to its end, waits, slides back and waits, over and over. This measures
// it; each bundle's Marquee component renders the box and the text, and its
// styles (.kfMarquee in the display's ui.css, Marquee.module.scss in the
// remote) run the animation from what this puts on the box:
//
//   data-marquee            the text doesn't fit
//   --kf-marquee-shift      how far it slides, in px
//   --kf-marquee-duration   one way, in seconds
//   --kf-marquee-hold       the part of that spent still at each end
//
// The animation runs one way, then back (alternate), holding at each end
// for half the pause each time: the whole pause at either end.

// How fast it slides, in rem a second: 32 px a second at 16px (a phone, or
// the display at 1080p), so it reads at the same pace at any size.
const SPEED_REM = 2;
// How long it waits at each end, in seconds.
const PAUSE_S = 2;
// A new duration this close to the one running (a fraction of it) keeps
// the running one, so a box that grows or shrinks by a pixel or two (a
// countdown beside it) doesn't make the text jump.
const KEEP_WITHIN = 0.05;

export interface MarqueeTiming {
  // How far the text slides, in px.
  shift: number;
  // One way, in seconds: half the pause, the slide, the other half.
  duration: number;
  // The part of the duration spent still at each end, in percent.
  hold: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

// How a line `overflow` px wider than its box moves at `speed` px a second,
// or null when it fits. `current` is the timing it has now, if any.
export function marqueeTiming(
  overflow: number,
  speed: number,
  current: MarqueeTiming | null = null,
): MarqueeTiming | null {
  if (!(overflow >= 1) || !(speed > 0)) return null;
  const shift = Math.ceil(overflow);
  const duration = round(shift / speed + PAUSE_S);
  if (
    current &&
    Math.abs(duration - current.duration) <= current.duration * KEEP_WITHIN
  ) {
    return { ...current, shift };
  }
  return { shift, duration, hold: round(((PAUSE_S / 2) * 100) / duration) };
}

// The boxes on screen, each with its text, and the timing each has now.
const texts = new Map<Element, HTMLElement>();
const boxes = new WeakMap<Node, HTMLElement>();
const timings = new WeakMap<Element, MarqueeTiming>();

// One observer for every box's size, and one for every text's changes
// (text from a component inside, such as a reading, changes without the
// Marquee rendering again). A long list of results measures in one go.
let resizes: ResizeObserver | undefined;
let edits: MutationObserver | undefined;

function measure(entries: ResizeObserverEntry[]) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const speed = SPEED_REM * (rem || 16);
  // Every read, then every write, so the page lays out once.
  const next: [HTMLElement, MarqueeTiming | null][] = [];
  for (const { target } of entries) {
    const box = target as HTMLElement;
    const text = texts.get(box);
    if (!text) continue;
    const overflow = text.scrollWidth - box.clientWidth;
    next.push([box, marqueeTiming(overflow, speed, timings.get(box))]);
  }
  for (const [box, timing] of next) show(box, timing);
}

function show(box: HTMLElement, timing: MarqueeTiming | null) {
  const before = timings.get(box);
  if (!timing) {
    if (before) {
      timings.delete(box);
      delete box.dataset.marquee;
    }
    return;
  }
  if (before?.shift === timing.shift && before.duration === timing.duration) {
    return;
  }
  timings.set(box, timing);
  box.style.setProperty("--kf-marquee-shift", `${timing.shift}px`);
  box.style.setProperty("--kf-marquee-duration", `${timing.duration}s`);
  box.style.setProperty("--kf-marquee-hold", `${timing.hold}%`);
  box.dataset.marquee = "";
}

// Measures a box again after the next layout: observing it anew reports
// its size again.
function remeasure(box: HTMLElement) {
  resizes?.unobserve(box);
  resizes?.observe(box);
}

function edited(records: MutationRecord[]) {
  const changed = new Set<HTMLElement>();
  for (const { target } of records) {
    for (let node: Node | null = target; node; node = node.parentNode) {
      const box = boxes.get(node);
      if (box) {
        changed.add(box);
        break;
      }
    }
  }
  for (const box of changed) if (texts.has(box)) remeasure(box);
}

function watch(box: HTMLElement, text: HTMLElement) {
  resizes ??= new ResizeObserver(measure);
  edits ??= new MutationObserver(edited);
  texts.set(box, text);
  boxes.set(text, box);
  resizes.observe(box);
  edits.observe(text, { characterData: true, childList: true, subtree: true });
}

function unwatch(box: HTMLElement) {
  texts.delete(box);
  timings.delete(box);
  resizes?.unobserve(box);
}

// The refs for a Marquee's box (which clips, and has no padding) and its
// text (the one element inside it, which slides). The box is measured
// before it's first shown, again when its size or its text changes.
export default function useMarquee<
  Box extends HTMLElement = HTMLSpanElement,
  Text extends HTMLElement = HTMLSpanElement,
>() {
  const box = useRef<Box>(null);
  const text = useRef<Text>(null);
  useLayoutEffect(() => {
    const boxElement = box.current;
    if (!boxElement || !text.current) return;
    watch(boxElement, text.current);
    return () => unwatch(boxElement);
  }, []);
  return { box, text };
}
