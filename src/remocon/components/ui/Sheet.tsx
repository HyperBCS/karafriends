import React, { useId, useLayoutEffect, useRef } from "react";

import { t } from "../../i18n";
import { FaAngleDown, FaAngleUp } from "../../icons";
import * as styles from "./Sheet.module.scss";

interface Props {
  // Names the sheet for screen readers.
  label: string;
  // The bar that always shows: the current song and its singer. It sits
  // beside the toggle, not in it: a tap on it goes through to the toggle,
  // except on a link in it, which keeps its own taps.
  header: React.ReactNode;
  // What expanding shows: the queue, the controls.
  children: React.ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

// How far a finger moves on the bar before it drags the sheet rather than
// tapping it.
const DRAG_SLOP_PX = 8;
// A flick opens or folds the sheet the way it went, however little it
// moved: a drag let go while moving faster than this (px per ms), or one
// over within FLICK_MS.
const FLICK_SPEED = 0.5;
const FLICK_MS = 250;
// How long the sheet takes to open or fold, from closed to open; one
// dragged part of the way takes the rest of that time.
const MOTION_MS = 280;
// Fast out, slow in: the sheet's own easing.
const EASING = "cubic-bezier(0.2, 0, 0, 1)";

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

interface Drag {
  pointerId: number;
  // Where the finger went down: the sheet keeps under the finger from
  // there, once it drags.
  startY: number;
  // Past the slop: the sheet follows the finger.
  active: boolean;
  // The body's height when the drag started, and when open.
  startHeight: number;
  openHeight: number;
  // For the flick: when the finger went down, the last move, and the speed
  // up the screen (px per ms).
  downTime: number;
  lastY: number;
  lastTime: number;
  speed: number;
}

// The body's motion: an open or fold in progress, which a new one or a
// drag takes over from where it is.
interface Motion {
  stop: () => void;
}

// The now-playing panel at the bottom of the remote, lifted over the
// screen: a bar with a grab handle on top, and a body below it that the
// bar's toggle shows and hides. The toggle is the arrow at the bar's end
// ("Show queue", "Hide queue"), and it takes a tap anywhere on the bar: its
// tap area stretches under the bar's content, which lets taps through to
// it. A link in the content is beside the toggle, not nested in it, and
// stays above it. The bar also drags: up to open the sheet, down to fold
// it, following the finger and settling open or folded when let go (by
// how far it got, or which way it was flicked). Opening and folding slide
// the body, which stays its full height while it moves, so the sheet rises
// from the bottom of the screen as one piece (at once with reduced
// motion). The sheet doesn't position itself; the app's layout puts it at
// the bottom.
export const Sheet = ({
  label,
  header,
  children,
  expanded,
  onExpandedChange,
}: Props) => {
  const bodyId = useId();
  const sheet = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const motion = useRef<Motion | null>(null);
  // Until when the click that ends a drag (if one comes: a finger's drag
  // ends in none) mustn't also toggle the sheet or follow a link.
  const swallowClickUntil = useRef(0);
  // The body's hidden attribute is the sheet's own once it mounts (a fold
  // keeps the body shown until it's done), so React sets it only at first.
  const hiddenAtFirst = useRef(!expanded).current;
  const mounted = useRef(false);

  // The body as it is when open: its height, which the sheet's own
  // max-height may limit, measured with every style the motion sets taken
  // off for a moment (there's no paint in between).
  const openHeight = (): number => {
    const el = body.current!;
    const inner = content.current!;
    const saved = [el.hidden, el.style.cssText, inner.style.cssText] as const;
    el.hidden = false;
    el.style.cssText = "";
    inner.style.cssText = "";
    const height = el.getBoundingClientRect().height;
    [el.hidden, el.style.cssText, inner.style.cssText] = saved;
    return height;
  };

  const shownHeight = (): number =>
    body.current!.hidden ? 0 : body.current!.getBoundingClientRect().height;

  // The body at a height between folded and open, its content at full
  // height under it and clipped. The sheet says it's moving (data-moving)
  // until it settles.
  const holdAt = (height: number, full: number) => {
    const el = body.current!;
    const inner = content.current!;
    sheet.current!.dataset.moving = "";
    el.hidden = false;
    el.style.flex = "none";
    el.style.overflow = "hidden";
    el.style.height = `${height}px`;
    inner.style.flex = "none";
    inner.style.height = `${full}px`;
  };

  const settle = (open: boolean) => {
    const el = body.current!;
    el.style.cssText = "";
    content.current!.style.cssText = "";
    el.hidden = !open;
    delete sheet.current!.dataset.moving;
  };

  // Stops the motion in progress, holding the body where it got to.
  const stopMotion = () => {
    if (!motion.current) return;
    const height = shownHeight();
    motion.current.stop();
    motion.current = null;
    body.current!.style.transition = "";
    body.current!.style.height = `${height}px`;
  };

  // Opens or folds the body from wherever it is.
  const moveTo = (open: boolean) => {
    const el = body.current;
    if (!el) return;
    stopMotion();
    const full = openHeight();
    const from = shownHeight();
    const to = open ? full : 0;
    if (reducedMotion() || Math.abs(to - from) < 1 || full < 1) {
      settle(open);
      return;
    }
    holdAt(from, full);
    // Laid out at `from` before the transition starts.
    el.getBoundingClientRect();
    const ms = Math.max(120, (MOTION_MS * Math.abs(to - from)) / full);
    el.style.transition = `height ${ms}ms ${EASING}`;
    el.style.height = `${to}px`;
    const done = () => {
      stop();
      motion.current = null;
      settle(open);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === "height") done();
    };
    // In case the transition never ends (a tab in the background).
    const timer = setTimeout(done, ms + 100);
    const stop = () => {
      clearTimeout(timer);
      el.removeEventListener("transitionend", onEnd);
    };
    el.addEventListener("transitionend", onEnd);
    motion.current = { stop };
  };

  // A change of expanded, from the toggle, a drag or the caller (following
  // a link folds the sheet), moves the body; the first render just shows
  // it as it is.
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    moveTo(expanded);
    // moveTo reads only refs.
  }, [expanded]);

  useLayoutEffect(() => () => motion.current?.stop(), []);

  const onPointerDown = (e: React.PointerEvent) => {
    swallowClickUntil.current = 0;
    if (!e.isPrimary || e.button !== 0) return;
    // Every move of this pointer comes to what it pressed (and up to the
    // bar), wherever it goes, as a finger's do anyway: a mouse moved fast
    // leaves the bar before it drags. Its click still goes to what it
    // pressed.
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // Not a live pointer (one made up by a script): no drag needs it.
    }
    drag.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      active: false,
      startHeight: 0,
      openHeight: 0,
      downTime: e.timeStamp,
      lastY: e.clientY,
      lastTime: e.timeStamp,
      speed: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < DRAG_SLOP_PX) return;
      d.active = true;
      stopMotion();
      d.openHeight = openHeight();
      d.startHeight = shownHeight();
      holdAt(d.startHeight, d.openHeight);
    }
    const height = Math.min(
      d.openHeight,
      Math.max(0, d.startHeight + d.startY - e.clientY),
    );
    body.current!.style.height = `${height}px`;
    const elapsed = e.timeStamp - d.lastTime;
    if (elapsed > 0) {
      // Mostly the latest move, so a flick at the end counts.
      d.speed = 0.6 * ((d.lastY - e.clientY) / elapsed) + 0.4 * d.speed;
      d.lastY = e.clientY;
      d.lastTime = e.timeStamp;
    }
  };

  const endDrag = (e: React.PointerEvent, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (!d.active) return;
    swallowClickUntil.current = performance.now() + 400;
    // A pause before letting go is no flick; a quick swipe is, whatever
    // the speed of its last move said.
    let speed = e.timeStamp - d.lastTime > 100 ? 0 : d.speed;
    if (e.timeStamp - d.downTime < FLICK_MS) {
      speed = d.startY > e.clientY ? Infinity : -Infinity;
    }
    let open = shownHeight() > d.openHeight / 2;
    if (!cancelled && speed > FLICK_SPEED) open = true;
    if (!cancelled && speed < -FLICK_SPEED) open = false;
    if (open === expanded) moveTo(open);
    else onExpandedChange(open);
  };

  return (
    <section ref={sheet} aria-label={label} className={styles.sheet}>
      <div
        className={styles.bar}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
        onClickCapture={(e) => {
          if (performance.now() > swallowClickUntil.current) return;
          swallowClickUntil.current = 0;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className={styles.barContent}>{header}</div>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? t("sheet.hideQueue") : t("sheet.showQueue")}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span className={styles.arrow} aria-hidden="true">
            {expanded ? <FaAngleDown /> : <FaAngleUp />}
          </span>
        </button>
      </div>
      <div
        ref={body}
        id={bodyId}
        className={styles.body}
        hidden={hiddenAtFirst}
      >
        <div ref={content} className={styles.content}>
          {children}
        </div>
      </div>
    </section>
  );
};
