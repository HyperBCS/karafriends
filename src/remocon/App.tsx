import React, { Suspense, useEffect } from "react";
import {
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";

import NowPlayingSheet from "./components/NowPlayingSheet/NowPlayingSheet";
import { TopBar } from "./components/ui";
import useUserIdentity from "./hooks/useUserIdentity";
import { t } from "./i18n";
import { MdHistory, MdHome, MdPerson } from "./icons";
import AdhocLyricsPage from "./pages/AdhocLyricsPage";
import ArtistPage from "./pages/ArtistPage";
import HistoryPage from "./pages/HistoryPage";
import NiconicoPage from "./pages/NiconicoPage";
import ProfilePage from "./pages/ProfilePage";
import SearchPage from "./pages/SearchPage";
import SongPage from "./pages/SongPage";
import YouTubePage from "./pages/YouTubePage";

import * as styles from "./App.module.scss";

// /dev/ui, the review page for the UI primitives: on the dev server, and in
// a build made with VITE_KARAFRIENDS_DEV_UI=1 (for screenshots). Otherwise
// the route doesn't exist and the bundle leaves the page out.
const DevUiPage =
  import.meta.env.DEV || import.meta.env.VITE_KARAFRIENDS_DEV_UI === "1"
    ? React.lazy(() => import("./dev/DevUiPage"))
    : null;

// Nothing here reads the live state, which can change several times a second:
// each component that shows some of it follows just that part.
const App = () => (
  <HashRouter>
    <Routes>
      {DevUiPage && (
        <Route
          path="/dev/ui"
          element={
            // The page doesn't scroll (index.scss), so this does.
            <div className={styles.app}>
              <div className={styles.main}>
                <Suspense fallback={null}>
                  <DevUiPage />
                </Suspense>
              </div>
            </div>
          }
        />
      )}
      <Route path="*" element={<Shell />} />
    </Routes>
  </HashRouter>
);

type Place = "home" | "history" | "profile";

// The top bar's three places, in the same order on every screen.
const PLACES = [
  { place: "home", to: "/", label: "nav.home", icon: <MdHome /> },
  {
    place: "history",
    to: "/history",
    label: "nav.history",
    icon: <MdHistory />,
  },
  {
    place: "profile",
    to: "/profile",
    label: "nav.profile",
    icon: <MdPerson />,
  },
] as const;

interface ScreenProps {
  title: string;
  // Which of the three places this screen is, if one: its button shows in
  // the accent and does nothing. The search screen has nowhere to go back
  // to.
  current?: Place;
  // The profile screen on a first visit: no back button, and the three
  // buttons disabled until there's a nickname.
  firstVisit?: boolean;
  children: React.ReactNode;
}

// One screen: the top bar (back, the title, and Home, History and Profile)
// and the screen's content below it.
const Screen = ({ title, current, firstVisit, children }: ScreenProps) => {
  const navigate = useNavigate();
  // react-router counts the entries it pushed: back stays in the remote.
  const canGoBack = (window.history.state?.idx ?? 0) > 0;
  let back: string | (() => void) | undefined;
  if (current !== "home" && !firstVisit) {
    back = canGoBack ? () => navigate(-1) : "/";
  }

  return (
    <>
      <header>
        <TopBar
          title={title}
          back={back}
          trailing={PLACES.map(({ place, to, label, icon }) => {
            const here = place === current ? ("page" as const) : undefined;
            // A link can't be disabled: without an address, it's one in
            // name only (role), out of the tab order.
            return firstVisit ? (
              <a
                key={place}
                role="link"
                aria-disabled="true"
                aria-current={here}
                aria-label={t(label)}
                className={styles.iconLink}
              >
                {icon}
              </a>
            ) : (
              <Link
                key={place}
                to={to}
                aria-current={here}
                aria-label={t(label)}
                className={styles.iconLink}
                onClick={here && ((e) => e.preventDefault())}
              >
                {icon}
              </Link>
            );
          })}
        />
      </header>
      <main className={styles.main}>{children}</main>
    </>
  );
};

// The remote's screens above the now-playing sheet. A phone without a
// nickname gets the profile screen, and nothing else, until it picks one.
const Shell = () => {
  const { nickname } = useUserIdentity();
  const { pathname } = useLocation();

  // iOS scrolls the page to show a field above the keyboard, and can leave
  // it scrolled once the keyboard closes, with the top bar cut off.
  useEffect(() => {
    const unscroll = () => window.scrollTo(0, 0);
    window.addEventListener("focusout", unscroll);
    return () => window.removeEventListener("focusout", unscroll);
  }, []);

  if (!nickname) {
    if (pathname !== "/profile") return <Navigate replace to="/profile" />;
    return (
      <div className={styles.app}>
        <Screen title={t("profile.heading")} current="profile" firstVisit>
          <ProfilePage firstVisit />
        </Screen>
      </div>
    );
  }

  return (
    <div className={styles.app}>
      <Routes>
        <Route
          path="/"
          element={
            <Screen title={t("search.heading")} current="home">
              <SearchPage />
            </Screen>
          }
        />
        <Route
          path="/song/:id"
          element={
            <Screen title={t("source.dam")}>
              <SongPage kind="dam" />
            </Screen>
          }
        />
        {["/joysoundSong/:id", "/joysoundSong/:id/:youtubeVideoId"].map(
          (path) => (
            <Route
              key={path}
              path={path}
              element={
                <Screen title={t("source.joysound")}>
                  <SongPage kind="joysound" />
                </Screen>
              }
            />
          ),
        )}
        <Route
          path="/artist/:id"
          element={
            <Screen title={t("search.artist")}>
              <ArtistPage key="dam" kind="dam" />
            </Screen>
          }
        />
        <Route
          path="/joysoundArtist/:id"
          element={
            <Screen title={t("search.artist")}>
              <ArtistPage key="joysound" kind="joysound" />
            </Screen>
          }
        />
        <Route
          path="/search/youtube/:videoId"
          element={
            <Screen title={t("source.youtube")}>
              <YouTubePage />
            </Screen>
          }
        />
        <Route
          path="/search/niconico/:videoId"
          element={
            <Screen title={t("source.niconico")}>
              <NiconicoPage />
            </Screen>
          }
        />
        <Route
          path="/adhocLyrics/:id"
          element={
            <Screen title={t("lyrics.heading")}>
              <AdhocLyricsPage />
            </Screen>
          }
        />
        <Route
          path="/history"
          element={
            <Screen title={t("history.heading")} current="history">
              <HistoryPage />
            </Screen>
          }
        />
        <Route
          path="/profile"
          element={
            <Screen title={t("profile.heading")} current="profile">
              <ProfilePage />
            </Screen>
          }
        />
        {/* An old address (the six search pages), or a mistyped one. */}
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
      <footer>
        <NowPlayingSheet />
      </footer>
    </div>
  );
};

export default App;
