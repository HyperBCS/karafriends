import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";

import { LiveStateProvider } from "../common/apiClient";
import { createQueryClient } from "../common/apiQueries";
import App from "./App";
import { QueueNotifications } from "./hooks/useQueueNotifications";
import { LanguageProvider } from "./i18n";
import "./index.scss";

const queryClient = createQueryClient();

// iOS before 16 ignores overscroll-behavior (index.scss): a drag up or down
// that the scroller under the finger can't take any further would bounce
// the page, the bars with it. Stop those; pinches, sideways drags and
// sliders go through. (The touchstart listener also makes iOS Safari show
// :active, the buttons' pressed state.)
let last = { clientX: 0, clientY: 0 };
const passive = { passive: true };
document.addEventListener("touchstart", (e) => (last = e.touches[0]), passive);
const onTouchMove = (e: TouchEvent) => {
  const { clientX, clientY, target } = e.touches[0];
  const [dx, dy] = [clientX - last.clientX, clientY - last.clientY];
  last = e.touches[0];
  if (e.touches.length > 1 || Math.abs(dx) >= Math.abs(dy)) return;
  // The nearest scroller up from the finger; one moving up scrolls it down.
  for (let el = target as Element | null; el; el = el.parentElement) {
    if (el.tagName === "INPUT") return;
    const { scrollTop, clientHeight, scrollHeight } = el;
    if (scrollHeight <= clientHeight) continue;
    if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
    if (dy < 0 ? scrollTop + clientHeight < scrollHeight : scrollTop > 0) {
      return;
    }
    break;
  }
  e.preventDefault();
};
document.addEventListener("touchmove", onTouchMove, { passive: false });

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LiveStateProvider checkAdmin>
        {/* Outside LanguageProvider, so a language change doesn't remount
            it and repeat a notification (t() translates them as they go
            out). */}
        <QueueNotifications />
        {/* Inside the data providers: a language change remounts the app
            but keeps the queries and the live connection. */}
        <LanguageProvider>
          <App />
        </LanguageProvider>
      </LiveStateProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
