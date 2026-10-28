import React, { useState } from "react";
import { useNavigate } from "react-router";

import { ApiCallError, useIsAdmin } from "../../common/apiClient";
import { Button, InlineError, Tabs, TextField } from "../components/ui";
import useUserIdentity, { saveNickname } from "../hooks/useUserIdentity";
import { LANGUAGES, t, useLanguage, type Language } from "../i18n";
import * as styles from "./ProfilePage.module.scss";

// What to tell a guest whose sign-in failed.
function signInError(err: unknown): string {
  if (err instanceof ApiCallError) {
    if (err.status === 403) return t("profile.wrongPassword");
    if (err.status === 409) return t("profile.noPassword");
    if (err.status === 429) return t("profile.tooManyTries");
    return t("profile.signInFailed", { reason: err.message });
  }
  // fetch() itself failed: no connection.
  return t("common.offline");
}

const Nickname = ({ firstVisit }: { firstVisit: boolean }) => {
  const navigate = useNavigate();
  const { nickname } = useUserIdentity();
  const [draft, setDraft] = useState(nickname ?? "");
  const trimmed = draft.trim();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (trimmed === "") return;
    saveNickname(trimmed);
    setDraft(trimmed);
    // A new phone goes on to search once it has a name.
    if (firstVisit) navigate("/", { replace: true });
  };

  return (
    <form className={styles.section} onSubmit={submit}>
      {firstVisit && <p className={styles.text}>{t("profile.firstVisit")}</p>}
      <TextField
        label={t("profile.nickname")}
        value={draft}
        onValueChange={setDraft}
        autoFocus={firstVisit}
        autoComplete="nickname"
        enterKeyHint="done"
        maxLength={32}
      />
      <Button
        type="submit"
        variant={firstVisit ? "primary" : "secondary"}
        disabled={trimmed === "" || trimmed === nickname}
      >
        {t(firstVisit ? "profile.start" : "profile.saveNickname")}
      </Button>
    </form>
  );
};

const LanguagePicker = () => {
  const { language, setLanguage } = useLanguage();
  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>{t("language.label")}</h2>
      <Tabs<Language>
        label={t("language.label")}
        tabs={LANGUAGES.map((id) => ({ id, label: t(`language.${id}`) }))}
        selected={language}
        onSelect={setLanguage}
      />
    </div>
  );
};

// Asks the phone to show a notification when this phone's song is up soon
// or couldn't be downloaded (useQueueNotifications). Browsers only ask
// once; after that, it's the browser's setting.
const Notifications = () => {
  const supported = "Notification" in window;
  const [permission, setPermission] = useState(
    supported ? Notification.permission : "denied",
  );
  if (!supported) return null;

  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>{t("profile.notifications")}</h2>
      {permission === "default" ? (
        <Button
          variant="secondary"
          onClick={async () =>
            setPermission(await Notification.requestPermission())
          }
        >
          {t("profile.notificationsOn")}
        </Button>
      ) : (
        <p className={styles.text}>
          {t(
            permission === "granted"
              ? "profile.notificationsAllowed"
              : "profile.notificationsBlocked",
          )}
        </p>
      )}
    </div>
  );
};

// Signing in and out as an admin with the password the host set.
const Admin = () => {
  const { adminToken, signIn, signOut } = useUserIdentity();
  const isAdmin = useIsAdmin();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signed in, until whoami says so.
  const confirming = adminToken !== null && isAdmin !== true;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password === "" || pending) return;
    setPending(true);
    setError(null);
    try {
      await signIn(password);
      setPassword("");
    } catch (err) {
      setError(signInError(err));
    } finally {
      setPending(false);
    }
  };

  const leave = async () => {
    setPending(true);
    await signOut();
    setPending(false);
  };

  if (isAdmin === true) {
    return (
      <div className={styles.section}>
        <h2 className={styles.heading}>{t("profile.admin")}</h2>
        <p className={styles.text} role="status">
          {t("profile.signedIn")}
        </p>
        <Button variant="secondary" disabled={pending} onClick={leave}>
          {t("profile.signOut")}
        </Button>
      </div>
    );
  }
  return (
    <form className={styles.section} onSubmit={submit}>
      <h2 className={styles.heading}>{t("profile.admin")}</h2>
      <TextField
        label={t("profile.adminPassword")}
        type="password"
        autoComplete="current-password"
        value={password}
        onValueChange={setPassword}
      />
      <Button
        type="submit"
        variant="secondary"
        disabled={password === "" || pending || confirming}
      >
        {t("profile.signIn")}
      </Button>
      {error && <InlineError>{error}</InlineError>}
    </form>
  );
};

// The phone's nickname, language, notifications and admin sign-in. On a
// first visit, just the nickname (and the language, to read the rest in).
const ProfilePage = ({ firstVisit = false }: { firstVisit?: boolean }) => (
  <div className={styles.profile}>
    <Nickname firstVisit={firstVisit} />
    <LanguagePicker />
    {!firstVisit && (
      <>
        <Notifications />
        <Admin />
      </>
    )}
  </div>
);

export default ProfilePage;
