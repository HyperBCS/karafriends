import React, { useState } from "react";

import { ApiCallError, useIsAdmin } from "../../common/apiClient";
import { Button, InlineError, TextField } from "../components/ui";
import useUserIdentity from "../hooks/useUserIdentity";
import { t } from "../i18n";
import * as styles from "./ProfilePage.module.scss";

// What to tell a guest whose sign-in failed.
function signInError(err: unknown): string {
  if (err instanceof ApiCallError) {
    if (err.status === 403) return t("profile.wrongPassword");
    if (err.status === 429) return t("profile.tooManyTries");
    return t("profile.signInFailed", { reason: err.message });
  }
  // fetch() itself failed: no connection.
  return t("common.offline");
}

// The phone's nickname, and signing in and out as an admin with the
// password the host set. A first version: C adds the nickname editor, the
// language toggle and notifications.
const ProfilePage = () => {
  const { nickname, adminToken, signIn, signOut } = useUserIdentity();
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

  return (
    <div className={styles.profile}>
      <h2>{t("profile.heading")}</h2>
      <dl className={styles.facts}>
        <dt>{t("profile.nickname")}</dt>
        <dd>{nickname}</dd>
      </dl>
      {isAdmin === true ? (
        <div className={styles.signedIn}>
          <p role="status">{t("profile.signedIn")}</p>
          <Button
            variant="secondary"
            aria-label={t("profile.signOut")}
            disabled={pending}
            onClick={leave}
          >
            {t("profile.signOut")}
          </Button>
        </div>
      ) : (
        <form className={styles.form} onSubmit={submit}>
          <TextField
            label={t("profile.adminPassword")}
            type="password"
            autoComplete="current-password"
            value={password}
            onValueChange={setPassword}
          />
          <Button
            type="submit"
            aria-label={t("profile.signIn")}
            disabled={password === "" || pending || confirming}
          >
            {t("profile.signIn")}
          </Button>
          {error && <InlineError>{error}</InlineError>}
        </form>
      )}
    </div>
  );
};

export default ProfilePage;
