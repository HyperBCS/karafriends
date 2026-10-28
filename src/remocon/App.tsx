import React, { Suspense } from "react";
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
import { MdPerson } from "./icons";
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
            <Suspense fallback={null}>
              <DevUiPage />
            </Suspense>
          }
        />
      )}
      <Route path="*" element={<Shell />} />
    </Routes>
  </HashRouter>
);

interface ScreenProps {
  title: string;
  // The search screen: nowhere to go back to.
  home?: boolean;
  // The profile screen: no profile button. On a first visit, no back
  // button either.
  profile?: boolean;
  firstVisit?: boolean;
  children: React.ReactNode;
}

// One screen: the top bar (back, the title, the profile button) and the
// screen's content below it.
const Screen = ({
  title,
  home,
  profile,
  firstVisit,
  children,
}: ScreenProps) => {
  const navigate = useNavigate();
  // react-router counts the entries it pushed: back stays in the remote.
  const canGoBack = (window.history.state?.idx ?? 0) > 0;
  let back: string | (() => void) | undefined;
  if (!home && !firstVisit) back = canGoBack ? () => navigate(-1) : "/";

  return (
    <>
      <header>
        <TopBar
          title={title}
          back={back}
          trailing={
            !profile && (
              <Link
                to="/profile"
                className={styles.iconLink}
                aria-label={t("nav.profile")}
              >
                <MdPerson />
              </Link>
            )
          }
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

  if (!nickname) {
    if (pathname !== "/profile") return <Navigate replace to="/profile" />;
    return (
      <div className={styles.app}>
        <Screen title={t("profile.heading")} profile firstVisit>
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
            <Screen title={t("search.heading")} home>
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
            <Screen title={t("history.heading")}>
              <HistoryPage />
            </Screen>
          }
        />
        <Route
          path="/profile"
          element={
            <Screen title={t("profile.heading")} profile>
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
