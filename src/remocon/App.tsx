import React, { Suspense, useEffect, useLayoutEffect, useRef } from "react";
import {
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
} from "react-router";

import CatalogGate from "./components/CatalogGate";
import NowPlayingSheet from "./components/NowPlayingSheet/NowPlayingSheet";
import { TopBar } from "./components/ui";
import useCatalog from "./hooks/useCatalog";
import useUserIdentity from "./hooks/useUserIdentity";
import { t } from "./i18n";
import { MdHistory, MdHome, MdLeaderboard, MdSettings } from "./icons";
import AdhocLyricsPage from "./pages/AdhocLyricsPage";
import ArtistPage from "./pages/ArtistPage";
import BrowsePage, { BrowseFeature, BrowseSongList } from "./pages/BrowsePage";
import HistoryPage from "./pages/HistoryPage";
import NiconicoPage from "./pages/NiconicoPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import SongPage from "./pages/SongPage";
import YouTubePage from "./pages/YouTubePage";
import { ARTIST_PAGES, BROWSE_PAGES, SONG_PAGES, sourceName } from "./songLink";

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

type Place = "browse" | "home" | "history" | "settings";

// The top bar's places, in the same order on every screen: Home at the far
// right. Browse only while the host has a Joysound login (its lists are
// Joysound's).
const PLACES = [
  {
    place: "browse",
    to: BROWSE_PAGES.browse,
    label: "nav.browse",
    icon: <MdLeaderboard />,
  },
  {
    place: "history",
    to: "/history",
    label: "nav.history",
    icon: <MdHistory />,
  },
  {
    place: "settings",
    to: "/settings",
    label: "nav.settings",
    icon: <MdSettings />,
  },
  { place: "home", to: "/", label: "nav.home", icon: <MdHome /> },
] as const;

interface ScreenProps {
  title: string;
  // Which of the three places this screen is, if one: its button shows in
  // the accent and does nothing. The search screen has nowhere to go back
  // to.
  current?: Place;
  // The settings screen on a first visit: no back button, and the three
  // buttons disabled until there's a nickname.
  firstVisit?: boolean;
  children: React.ReactNode;
}

// Where each entry in the history left its screen scrolled, by
// react-router's key for the entry. Every route's Screen is the same one
// <main>, so without this a screen opened at the last one's place, and
// Back landed at the top of a long list of results.
const scrolledTo = new Map<string, number>();

// Keeps the <main> scroller's place per history entry: a new screen opens
// at its top, Back and Forward find a screen where it was left, and a
// change in place (typing a search, a Joysound song's background) leaves
// it be.
function useScrollMemory(): {
  ref: React.RefObject<HTMLElement | null>;
  onScroll: (event: React.UIEvent<HTMLElement>) => void;
} {
  const ref = useRef<HTMLElement>(null);
  const location = useLocation();
  const navigationType = useNavigationType();
  const last = useRef(location);

  useLayoutEffect(() => {
    const main = ref.current;
    const before = last.current;
    last.current = location;
    if (!main || before.key === location.key) return;
    if (navigationType === "REPLACE" && before.pathname === location.pathname) {
      // The same entry under a new key.
      scrolledTo.set(location.key, main.scrollTop);
      return;
    }
    main.scrollTop =
      navigationType === "POP" ? (scrolledTo.get(location.key) ?? 0) : 0;
    scrolledTo.set(location.key, main.scrollTop);
  }, [location.key]);

  return {
    ref,
    // The rendered entry's: while another loads, this one is still shown.
    onScroll: (event) =>
      scrolledTo.set(location.key, event.currentTarget.scrollTop),
  };
}

// One screen: the top bar (back, the title, and History, Settings and Home)
// and the screen's content below it.
const Screen = ({ title, current, firstVisit, children }: ScreenProps) => {
  const navigate = useNavigate();
  const scroll = useScrollMemory();
  // react-router counts the entries it pushed: back stays in the remote.
  const canGoBack = (window.history.state?.idx ?? 0) > 0;
  let back: string | (() => void) | undefined;
  if (current !== "home" && !firstVisit) {
    back = canGoBack ? () => navigate(-1) : "/";
  }
  // Browse is Joysound's: there while its songs are on.
  const browse = useCatalog("joysound") === "on";
  const places = PLACES.filter(({ place }) => place !== "browse" || browse);

  return (
    <>
      <header>
        <TopBar
          title={title}
          back={back}
          trailing={places.map(({ place, to, label, icon }) => {
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
      <main ref={scroll.ref} className={styles.main} onScroll={scroll.onScroll}>
        {children}
      </main>
    </>
  );
};

// Each song, video or artist gets a page of its own. One opened from another
// of the same kind (song to song, through Now playing) mounts afresh, with
// its own spinner and no earlier error or button state, rather than the
// last one staying on screen, live, while the new one loads. Keyed by the
// id alone, so picking a Joysound song's background (a second param, in
// the address in place) keeps the page.
const PerId = ({
  page,
  param,
  children,
}: {
  page: string;
  param: string;
  children: React.ReactNode;
}) => {
  const id = useParams()[param];
  return <React.Fragment key={`${page}/${id}`}>{children}</React.Fragment>;
};

// The remote's screens above the now-playing sheet. A phone without a
// nickname gets the settings screen, and nothing else, until it picks one.
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
    if (pathname !== "/settings") return <Navigate replace to="/settings" />;
    return (
      <div className={styles.app}>
        <Screen title={t("settings.heading")} current="settings" firstVisit>
          <SettingsPage firstVisit />
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
          path={`${SONG_PAGES.dam}/:id`}
          element={
            <Screen title={sourceName("dam")}>
              <PerId page="dam" param="id">
                <CatalogGate catalog="dam">
                  <SongPage kind="dam" />
                </CatalogGate>
              </PerId>
            </Screen>
          }
        />
        {[":id", ":id/:youtubeVideoId"].map((path) => (
          <Route
            key={path}
            path={`${SONG_PAGES.joysound}/${path}`}
            element={
              <Screen title={sourceName("joysound")}>
                <PerId page="joysound" param="id">
                  <CatalogGate catalog="joysound">
                    <SongPage kind="joysound" />
                  </CatalogGate>
                </PerId>
              </Screen>
            }
          />
        ))}
        <Route
          path={`${ARTIST_PAGES.dam}/:id`}
          element={
            <Screen title={t("search.artist")}>
              <PerId page="damArtist" param="id">
                <CatalogGate catalog="dam">
                  <ArtistPage kind="dam" />
                </CatalogGate>
              </PerId>
            </Screen>
          }
        />
        <Route
          path={`${ARTIST_PAGES.joysound}/:id`}
          element={
            <Screen title={t("search.artist")}>
              <PerId page="joysoundArtist" param="id">
                <CatalogGate catalog="joysound">
                  <ArtistPage kind="joysound" />
                </CatalogGate>
              </PerId>
            </Screen>
          }
        />
        <Route
          path={`${SONG_PAGES.youtube}/:videoId`}
          element={
            <Screen title={sourceName("youtube")}>
              <PerId page="youtube" param="videoId">
                <YouTubePage />
              </PerId>
            </Screen>
          }
        />
        <Route
          path={`${SONG_PAGES.nico}/:videoId`}
          element={
            <Screen title={sourceName("nico")}>
              <PerId page="nico" param="videoId">
                <NiconicoPage />
              </PerId>
            </Screen>
          }
        />
        <Route
          path="/adhocLyrics/:id"
          element={
            <Screen title={t("lyrics.heading")}>
              <PerId page="adhocLyrics" param="id">
                <AdhocLyricsPage />
              </PerId>
            </Screen>
          }
        />
        <Route
          path={BROWSE_PAGES.browse}
          element={
            <Screen title={t("browse.heading")} current="browse">
              <CatalogGate catalog="joysound">
                <BrowsePage />
              </CatalogGate>
            </Screen>
          }
        />
        <Route
          path={BROWSE_PAGES.newSongs}
          element={
            <Screen title={t("browse.newSongs")}>
              <PerId page="browseNewSongs" param="id">
                <CatalogGate catalog="joysound">
                  <BrowseSongList which="newSongs" />
                </CatalogGate>
              </PerId>
            </Screen>
          }
        />
        <Route
          path={`${BROWSE_PAGES.genre}/:id`}
          element={
            <Screen title={t("browse.heading")}>
              <PerId page="browseGenre" param="id">
                <CatalogGate catalog="joysound">
                  <BrowseSongList which="genre" />
                </CatalogGate>
              </PerId>
            </Screen>
          }
        />
        <Route
          path={`${BROWSE_PAGES.feature}/:id`}
          element={
            <Screen title={t("browse.featured")}>
              <PerId page="browseFeature" param="id">
                <CatalogGate catalog="joysound">
                  <BrowseFeature />
                </CatalogGate>
              </PerId>
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
          path="/settings"
          element={
            <Screen title={t("settings.heading")} current="settings">
              <SettingsPage />
            </Screen>
          }
        />
        {/* The settings' old address, from when they were the profile. */}
        <Route path="/profile" element={<Navigate replace to="/settings" />} />
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
