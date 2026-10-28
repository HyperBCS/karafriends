import { useSyncExternalStore } from "react";

import { onAdminTokenChange, storedAdminToken } from "../../common/apiClient";
import { getItem, setItem } from "../../common/storage";

// The phone's identity, kept in localStorage: its nickname (set on the
// settings screen, which a new phone opens on) and its admin token while it
// is signed in as an admin ("adminToken"; see adminSignIn in apiClient).
// apiClient reads them, and the device ID it makes on the first request,
// for every request's headers, so a new nickname goes out with the next one.

const nicknameListeners = new Set<() => void>();

const storedNickname = () => getItem("nickname") || null;

function onNicknameChange(listener: () => void): () => void {
  nicknameListeners.add(listener);
  return () => nicknameListeners.delete(listener);
}

export function saveNickname(nickname: string) {
  setItem("nickname", nickname);
  for (const listener of nicknameListeners) listener();
}

const useUserIdentity = () => ({
  // Null until the phone has picked one.
  nickname: useSyncExternalStore(onNicknameChange, storedNickname),
  adminToken: useSyncExternalStore(onAdminTokenChange, storedAdminToken),
});

export default useUserIdentity;
