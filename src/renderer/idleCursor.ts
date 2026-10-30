// The mouse pointer over the display: hidden once the mouse has been still
// for HIDE_AFTER_MS, shown again as soon as it moves. App.tsx watches only
// while the window is in full screen and nothing on it is for the mouse
// (Settings, the setup screen).
//
// No DOM beyond EventTarget, so unit tests can run it under plain Node.

export const HIDE_AFTER_MS = 3000;

// What counts as using the mouse.
const MOUSE_EVENTS = ["mousemove", "mousedown", "wheel"] as const;

// Watches target (the document) and calls setHidden as the pointer should
// hide or show: hidden HIDE_AFTER_MS from now unless the mouse moves.
// Returns a function that stops watching and shows the pointer.
export function watchIdleCursor(
  target: EventTarget,
  setHidden: (hidden: boolean) => void,
  hideAfterMs: number = HIDE_AFTER_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hidden = false;
  const set = (value: boolean) => {
    if (value === hidden) return;
    hidden = value;
    setHidden(value);
  };
  const used = () => {
    set(false);
    clearTimeout(timer);
    timer = setTimeout(() => set(true), hideAfterMs);
  };
  used();
  for (const type of MOUSE_EVENTS) {
    target.addEventListener(type, used, { passive: true });
  }
  return () => {
    clearTimeout(timer);
    for (const type of MOUSE_EVENTS) target.removeEventListener(type, used);
    set(false);
  };
}
