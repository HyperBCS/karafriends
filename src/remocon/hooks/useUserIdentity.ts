import { useEffect, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import {
  adminSignIn,
  adminSignOut,
  onAdminTokenChange,
  storedAdminToken,
} from "../../common/apiClient";

// The phone's identity, kept in localStorage: its device ID (made on first
// visit), its nickname (asked for on first visit, with shouldPrompt), and
// its admin token while it is signed in as an admin ("adminToken"; see
// adminSignIn in apiClient, which also sends it with every request).
const useUserIdentity = (shouldPrompt?: boolean) => {
  const [deviceId, setDeviceId] = useState<string>("Unknown");
  const [nickname, setNickname] = useState<string>("Unknown");
  const [adminToken, setAdminToken] = useState<string | null>(storedAdminToken);

  useEffect(() => {
    if (!localStorage.getItem("deviceId")) {
      localStorage.setItem("deviceId", uuidv4());
    }

    if (shouldPrompt) {
      while ((localStorage.getItem("nickname") || "").length === 0) {
        localStorage.setItem(
          "nickname",
          prompt("Please set your nickname:") || "",
        );
      }
    }

    setDeviceId(localStorage.getItem("deviceId") || "Unknown");
    setNickname(localStorage.getItem("nickname") || "Unknown");
  }, []);

  useEffect(
    () => onAdminTokenChange(() => setAdminToken(storedAdminToken())),
    [],
  );

  return {
    nickname,
    deviceId,
    adminToken,
    signIn: adminSignIn,
    signOut: adminSignOut,
  };
};

export default useUserIdentity;
