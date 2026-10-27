import { useEffect } from "react";

import formatDuration from "format-duration";
import useQueue from "../../common/hooks/useQueue";

async function registerServiceWorker() {
  // static/notificationServiceWorker.js, served at the root.
  return navigator.serviceWorker.register("/notificationServiceWorker.js", {
    scope: "/",
  });
}

async function showNotification(
  ...args: ConstructorParameters<typeof Notification>
) {
  // Until the phone allows them (EnableNotificationsButton), showing one
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

// Whenever the queue changes, tells this phone about its songs due within
// ten minutes. It updates with the queue, so use it in a component of its
// own (QueueNotifications), not one with the pages under it.
export default function useQueueNotifications() {
  const queue = useQueue();

  // Preemptively register the service worker, once.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    registerServiceWorker().catch((err) =>
      console.warn("Couldn't register the service worker:", err),
    );
  }, []);

  useEffect(() => {
    for (const [item, eta] of queue) {
      if (item.isMine && eta <= 10 * 60) {
        showNotification("karafriends", {
          body: `Your song ${
            item.name
          } is coming up soon! Estimated wait: T-${formatDuration(eta * 1000)}`,
        }).catch((err) => console.warn("Couldn't show a notification:", err));
      }
    }
  }, [queue]);
}

// Shows the queue notifications, and nothing else.
export function QueueNotifications() {
  useQueueNotifications();
  return null;
}
