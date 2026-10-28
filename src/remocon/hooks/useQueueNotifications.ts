import { useEffect, useEffectEvent } from "react";

import formatDuration from "format-duration";
import type { SharedQueueItem } from "../../common/api";
import { useLiveEvent, useLiveState } from "../../common/apiClient";
import useQueue from "../../common/hooks/useQueue";
import { reading } from "../../common/readings";
import { t } from "../i18n";

async function registerServiceWorker() {
  // static/notificationServiceWorker.js, served at the root.
  return navigator.serviceWorker.register("/notificationServiceWorker.js", {
    scope: "/",
  });
}

async function showNotification(
  ...args: ConstructorParameters<typeof Notification>
) {
  // Until the phone allows them (on the settings screen), showing one
  // only throws.
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  if ("serviceWorker" in navigator) {
    const registration = await registerServiceWorker();
    return registration.showNotification(...args);
  }
  new Notification(...args);
}

// The song as this phone reads it: only the phone that queued it gets these
// notifications, and the song carries that phone's Readings.
const shownName = (item: SharedQueueItem) =>
  reading(item.name, item.nameYomi, item.readingsMode ?? "written") ??
  item.name;

// Whenever the queue changes, tells this phone about its songs due within
// ten minutes, and about its songs that couldn't be downloaded. It updates
// once a second while a song plays, so use it in a component of its own
// (QueueNotifications), not one with the pages under it.
export default function useQueueNotifications() {
  // The waits from where the current song is, but only when the songs
  // queued change: on every tick, or on the current song's length coming
  // in, the same notifications would come again.
  const queue = useQueue();
  const songs = useLiveState((state) => state?.queue);

  // Preemptively register the service worker, once.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    registerServiceWorker().catch((err) =>
      console.warn("Couldn't register the service worker:", err),
    );
  }, []);

  const notifyDue = useEffectEvent(() => {
    for (const [item, eta] of queue) {
      if (item.isMine && eta <= 10 * 60) {
        showNotification("karafriends", {
          body: t("notification.upSoon", {
            name: shownName(item),
            eta: formatDuration(eta * 1000),
          }),
        }).catch((err) => console.warn("Couldn't show a notification:", err));
      }
    }
  });
  useEffect(() => {
    if (songs) notifyDue();
  }, [songs]);

  // The server sends these only to the phone that queued the song.
  useLiveEvent("queueFailed", ({ item, reason }) => {
    showNotification("karafriends", {
      body: t("notification.failed", { name: shownName(item), reason }),
    }).catch((err) => console.warn("Couldn't show a notification:", err));
  });
}

// Shows the queue notifications, and nothing else.
export function QueueNotifications() {
  useQueueNotifications();
  return null;
}
