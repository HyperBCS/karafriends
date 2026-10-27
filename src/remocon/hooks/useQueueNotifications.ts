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
// ten minutes.
export default function useQueueNotifications() {
  const queue = useQueue();

  // Preemptively register the service worker
  if ("serviceWorker" in navigator) registerServiceWorker();

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
