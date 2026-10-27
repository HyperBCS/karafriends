import { useEffect, useSyncExternalStore } from "react";
import { v4 as uuidv4 } from "uuid";

import {
  adminSignIn,
  adminSignOut,
  onAdminTokenChange,
  storedAdminToken,
} from "../../common/apiClient";

// The phone's identity, kept in localStorage: its device ID (made on first
// visit), its nickname (set on the profile screen, which a new phone opens
// on), and its admin token while it is signed in as an admin ("adminToken";
// see adminSignIn in apiClient). apiClient reads them from localStorage for
// every request's headers, so a new nickname goes out with the next one.

const nicknameListeners = new Set<() => void>();

function storedNickname(): string | null {
  try {
    return localStorage.getItem("nickname") || null;
  } catch {
    return null;
  }
}

function onNicknameChange(listener: () => void): () => void {
  nicknameListeners.add(listener);
  return () => nicknameListeners.delete(listener);
}

export function saveNickname(nickname: string) {
  localStorage.setItem("nickname", nickname);
  for (const listener of nicknameListeners) listener();
}

const useUserIdentity = () => {
  const nickname = useSyncExternalStore(onNicknameChange, storedNickname);
  const adminToken = useSyncExternalStore(onAdminTokenChange, storedAdminToken);

  useEffect(() => {
    if (!localStorage.getItem("deviceId")) {
      localStorage.setItem("deviceId", uuidv4());
    }
  }, []);

  return {
    // Null until the phone has picked one.
    nickname,
    adminToken,
    signIn: adminSignIn,
    signOut: adminSignOut,
  };
};

export default useUserIdentity;
