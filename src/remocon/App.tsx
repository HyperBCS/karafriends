import React, { Suspense } from "react";
import { HashRouter, Route, Routes } from "react-router";

import ControlBar from "./components/ControlBar";
import NavBar from "./components/NavBar";
import useUserIdentity from "./hooks/useUserIdentity";
import AdhocLyricsPage from "./pages/AdhocLyricsPage";
import ArtistPage from "./pages/ArtistPage";
import ArtistSearchPage from "./pages/ArtistSearchPage";
import HistoryPage from "./pages/HistoryPage";
import HomePage from "./pages/HomePage";
import JoysoundArtistPage from "./pages/JoysoundArtistPage";
import JoysoundArtistSearchPage from "./pages/JoysoundArtistSearchPage";
import JoysoundSongPage from "./pages/JoysoundSongPage";
import JoysoundSongSearchPage from "./pages/JoysoundSongSearchPage";
import NiconicoPage from "./pages/NiconicoPage";
import SongPage from "./pages/SongPage";
import SongSearchPage from "./pages/SongSearchPage";
import YouTubePage from "./pages/YouTubePage";

import * as styles from "./App.module.scss";
import { QueueNotifications } from "./hooks/useQueueNotifications";

// /dev/ui, the review page for the UI primitives: on the dev server, and in
// a build made with VITE_KARAFRIENDS_DEV_UI=1 (for screenshots). Otherwise
// the route doesn't exist and the bundle leaves the page out.
const DevUiPage =
  import.meta.env.DEV || import.meta.env.VITE_KARAFRIENDS_DEV_UI === "1"
    ? React.lazy(() => import("./dev/DevUiPage"))
    : null;

// Nothing here reads the live state, which can change several times a second:
// each component that shows some of it follows just that part.
const App = () => {
  // Asks a new phone for its nickname.
  useUserIdentity(true);

  return (
    <HashRouter>
      <QueueNotifications />
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
};

// The remote's screens, between the nav bar and the control bar.
const Shell = () => (
  <div className={styles.app}>
    <header>
      <NavBar />
    </header>
    <main>
      <Routes>
        <Route path="/song/:id" element={<SongPage />} />
        <Route path="/artist/:id" element={<ArtistPage />} />
        <Route path="/adhocLyrics/:id" element={<AdhocLyricsPage />} />
        <Route path="/joysoundSong/:id" element={<JoysoundSongPage />} />
        <Route
          path="/joysoundSong/:id/:youtubeVideoId"
          element={<JoysoundSongPage />}
        />
        <Route path="/joysoundArtist/:id" element={<JoysoundArtistPage />} />
        <Route path="/search/song/:query?" element={<SongSearchPage />} />
        <Route path="/search/artist/:query?" element={<ArtistSearchPage />} />
        <Route path="/search/youtube/:videoId?" element={<YouTubePage />} />
        <Route path="/search/niconico/:videoId?" element={<NiconicoPage />} />
        <Route
          path="/search/joysoundSong/:query?"
          element={<JoysoundSongSearchPage />}
        />
        <Route
          path="/search/joysoundArtist/:query?"
          element={<JoysoundArtistSearchPage />}
        />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/" element={<HomePage />} />
      </Routes>
    </main>
    <footer>
      <ControlBar />
    </footer>
  </div>
);

export default App;
