// /dev/ui: every UI primitive in every state, in either language, for
// reviewing the look against the design brief (notes/PLAN-product.md).
// Only in dev builds (see App.tsx). Pressed and focus states are forced with
// data-demo (see tokens.scss), so a screenshot shows them.
import React, { useState } from "react";

import {
  Button,
  EmptyState,
  IconButton,
  InlineError,
  List,
  ListRow,
  Sheet,
  Tabs,
  TextField,
  TopBar,
} from "../components/ui";
import { SingerBadge } from "../components/NowPlayingSheet/QueueList";
import { t, useLanguage, type Language } from "../i18n";
import {
  FaSmile,
  MdClose,
  MdPause,
  MdPerson,
  MdPlayArrow,
  MdReplay,
  MdSearch,
  MdSkipNext,
  MdTranslate,
} from "../icons";
import * as styles from "./DevUiPage.module.scss";

// Real songs, as DAM, Joysound, YouTube and Niconico list them.
const SONGS = {
  yoruNiKakeru: { title: "夜に駆ける", artist: "YOASOBI" },
  lemon: { title: "Lemon", artist: "米津玄師" },
  pretender: {
    title: "Official髭男dism - Pretender［Official Video］",
    artist: "Official髭男dism",
  },
  senbonzakura: {
    title: "【初音ミク】千本桜【オリジナル曲PV】",
    artist: "黒うさP",
  },
  zankoku: {
    title:
      "残酷な天使のテーゼ (TVアニメ『新世紀エヴァンゲリオン』オープニングテーマ)",
    artist: "高橋洋子",
  },
  marigold: { title: "マリーゴールド", artist: "あいみょん" },
  gurenge: { title: "紅蓮華", artist: "LiSA" },
  hakujitsu: { title: "白日", artist: "King Gnu" },
  firstLove: { title: "First Love", artist: "宇多田ヒカル" },
};

const noop = () => {};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className={styles.section} aria-label={title}>
    <h2 className={styles.sectionTitle}>{title}</h2>
    {children}
  </section>
);

// One primitive in one state, with the state's name above it.
const Demo = ({
  state,
  force,
  children,
}: {
  state: string;
  force?: "pressed" | "focus";
  children: React.ReactNode;
}) => (
  <figure className={styles.demo}>
    <figcaption className={styles.caption}>{state}</figcaption>
    <div data-demo={force}>{children}</div>
  </figure>
);

const Initial = ({ name }: { name: string }) => (
  <span className={styles.initial} aria-hidden="true">
    {name.slice(0, 1).toUpperCase()}
  </span>
);

// The songs waiting, as the sheet's queue shows them.
const QueueRows = () => (
  <>
    <ListRow
      leading={<Initial name="あやか" />}
      title={SONGS.gurenge.title}
      subtitle={SONGS.gurenge.artist}
      source={t("source.joysound")}
      onPress={noop}
      trailing={
        <>
          +4:12
          <IconButton
            label={t("queue.remove")}
            icon={<MdClose />}
            tone="danger"
          />
        </>
      }
    />
    <ListRow
      leading={<Initial name="Mio" />}
      title={SONGS.pretender.title}
      subtitle={SONGS.pretender.artist}
      source={t("source.youtube")}
      onPress={noop}
      trailing="+8:31"
    />
    <ListRow
      leading={<Initial name="Taro" />}
      title={SONGS.senbonzakura.title}
      subtitle={SONGS.senbonzakura.artist}
      source={t("source.niconico")}
      onPress={noop}
      trailing="+13:05"
    />
  </>
);

const DevUiPage = () => {
  const { language, setLanguage } = useLanguage();
  const [query, setQuery] = useState("紅蓮華");
  const [empty, setEmpty] = useState("");
  const [by, setBy] = useState<"title" | "artist">("title");
  const [source, setSource] = useState<"all" | "dam" | "joysound">("all");
  const [sheetOpen, setSheetOpen] = useState(true);

  const byTabs = [
    { id: "title", label: t("search.title") },
    { id: "artist", label: t("search.artist") },
  ] as const;
  const sourceTabs = [
    { id: "all", label: t("search.sourceAll") },
    { id: "dam", label: t("source.dam") },
    { id: "joysound", label: t("source.joysound") },
  ] as const;

  // As the real bar has it (NowPlaying), folded: the label, the artist
  // under the title, the singer on the right.
  const nowPlaying = (
    <span className={styles.nowPlaying}>
      <span className={styles.nowLabel}>{t("sheet.nowPlaying")}</span>
      <span className={styles.nowRow}>
        <span className={styles.nowSong}>
          <span className={styles.nowTitle}>{SONGS.marigold.title}</span>
          <span className={styles.nowArtist}>{SONGS.marigold.artist}</span>
        </span>
        <SingerBadge nickname="Ken" />
      </span>
    </span>
  );
  // The queue as the open sheet shows it.
  const upNext = (
    <>
      <h3 className={styles.upNext}>{t("queue.upNext")}</h3>
      <List label={t("queue.upNext")}>
        <QueueRows />
      </List>
    </>
  );

  return (
    <div className={styles.page}>
      <TopBar
        title="UI"
        trailing={
          <Tabs<Language>
            label={t("language.label")}
            tabs={[
              { id: "en", label: t("language.en") },
              { id: "ja", label: t("language.ja") },
            ]}
            selected={language}
            onSelect={setLanguage}
          />
        }
      />

      <Section title="TopBar">
        <div className={styles.bleed}>
          <Demo state="home">
            <TopBar
              title={t("search.heading")}
              trailing={
                <IconButton label={t("nav.profile")} icon={<MdPerson />} />
              }
            />
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="back, long title">
            <TopBar
              back="/dev/ui"
              title={SONGS.zankoku.title}
              trailing={
                <IconButton
                  label={t("language.label")}
                  icon={<MdTranslate />}
                />
              }
            />
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="back: pressed" force="pressed">
            <TopBar back={noop} title={SONGS.yoruNiKakeru.title} />
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="back: focus" force="focus">
            <TopBar back={noop} title={SONGS.yoruNiKakeru.title} />
          </Demo>
        </div>
      </Section>

      <Section title="Button">
        <div className={styles.row}>
          <Demo state="primary">
            <Button>{t("queueButton.song")}</Button>
          </Demo>
          <Demo state="pressed" force="pressed">
            <Button>{t("queueButton.song")}</Button>
          </Demo>
          <Demo state="focus" force="focus">
            <Button>{t("queueButton.song")}</Button>
          </Demo>
        </div>
        <div className={styles.row}>
          <Demo state="secondary">
            <Button variant="secondary">{t("common.cancel")}</Button>
          </Demo>
          <Demo state="pressed" force="pressed">
            <Button variant="secondary">{t("common.cancel")}</Button>
          </Demo>
          <Demo state="focus" force="focus">
            <Button variant="secondary">{t("common.cancel")}</Button>
          </Demo>
        </div>
        <div className={styles.row}>
          <Demo state="danger">
            <Button variant="danger">{t("queue.remove")}</Button>
          </Demo>
          <Demo state="pressed" force="pressed">
            <Button variant="danger">{t("queue.remove")}</Button>
          </Demo>
          <Demo state="focus" force="focus">
            <Button variant="danger">{t("queue.remove")}</Button>
          </Demo>
        </div>
        <Demo state="disabled (any variant)">
          <Button disabled full>
            {t("queueButton.downloadingPercent", { percent: "42.6" })}
          </Button>
        </Demo>
        <Demo state="full width">
          <Button full>{t("search.label")}</Button>
        </Demo>
      </Section>

      <Section title="IconButton">
        <div className={styles.row}>
          <Demo state="default">
            <IconButton label={t("playback.restart")} icon={<MdReplay />} />
          </Demo>
          <Demo state="accent">
            <IconButton
              label={t("playback.play")}
              icon={<MdPlayArrow />}
              tone="accent"
            />
          </Demo>
          <Demo state="danger">
            <IconButton
              label={t("queue.remove")}
              icon={<MdClose />}
              tone="danger"
            />
          </Demo>
          <Demo state="toggle on">
            <IconButton
              label={t("sheet.showEmotes")}
              icon={<FaSmile />}
              aria-pressed
            />
          </Demo>
        </div>
        <div className={styles.row}>
          <Demo state="pressed" force="pressed">
            <IconButton label={t("playback.pause")} icon={<MdPause />} />
          </Demo>
          <Demo state="focus" force="focus">
            <IconButton label={t("playback.skip")} icon={<MdSkipNext />} />
          </Demo>
          <Demo state="disabled">
            <IconButton
              label={t("playback.skip")}
              icon={<MdSkipNext />}
              disabled
            />
          </Demo>
        </div>
      </Section>

      <Section title="ListRow">
        <div className={styles.bleed}>
          <Demo state="search results: one row style for every source">
            <List label={t("search.label")}>
              <ListRow
                title={SONGS.yoruNiKakeru.title}
                subtitle={SONGS.yoruNiKakeru.artist}
                source={t("source.dam")}
                to="/dev/ui"
              />
              <ListRow
                title={SONGS.lemon.title}
                subtitle={SONGS.lemon.artist}
                source={t("source.joysound")}
                to="/dev/ui"
              />
              <ListRow
                title={SONGS.pretender.title}
                subtitle={SONGS.pretender.artist}
                source={t("source.youtube")}
                to="/dev/ui"
              />
              <ListRow
                title={SONGS.zankoku.title}
                subtitle={SONGS.zankoku.artist}
                source={t("source.dam")}
                to="/dev/ui"
              />
            </List>
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="queue: current, leading and trailing slots">
            <List label={t("queue.label")}>
              <ListRow
                current
                leading={<Initial name="Ken" />}
                title={SONGS.marigold.title}
                subtitle={SONGS.marigold.artist}
                source={t("source.dam")}
                onPress={noop}
              />
              <QueueRows />
            </List>
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="pressed" force="pressed">
            <List>
              <ListRow
                title={SONGS.hakujitsu.title}
                subtitle={SONGS.hakujitsu.artist}
                source={t("source.dam")}
                onPress={noop}
              />
            </List>
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="focus" force="focus">
            <List>
              <ListRow
                title={SONGS.hakujitsu.title}
                subtitle={SONGS.hakujitsu.artist}
                source={t("source.dam")}
                onPress={noop}
              />
            </List>
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="not pressable (history)">
            <List label={t("history.heading")}>
              <ListRow
                title={SONGS.firstLove.title}
                subtitle={SONGS.firstLove.artist}
                source={t("source.joysound")}
                trailing="21:04"
              />
            </List>
          </Demo>
        </div>
      </Section>

      <Section title="TextField">
        <Demo state="empty, placeholder">
          <TextField
            label={t("search.label")}
            placeholder={t("search.placeholder")}
            value={empty}
            onValueChange={setEmpty}
            clearable
          />
        </Demo>
        <Demo state="filled, clear button">
          <TextField
            label={t("search.label")}
            value={query}
            onValueChange={setQuery}
            clearable
          />
        </Demo>
        <Demo state="focus, hidden label, icon" force="focus">
          <TextField
            label={t("search.label")}
            hideLabel
            icon={<MdSearch />}
            type="search"
            enterKeyHint="search"
            placeholder={t("search.placeholder")}
            value=""
            onValueChange={noop}
          />
        </Demo>
      </Section>

      <Section title="Tabs">
        <Demo state="two tabs">
          <Tabs
            label={t("search.byLabel")}
            tabs={byTabs}
            selected={by}
            onSelect={setBy}
          />
        </Demo>
        <Demo state="three tabs">
          <Tabs
            label={t("search.sourceLabel")}
            tabs={sourceTabs}
            selected={source}
            onSelect={setSource}
          />
        </Demo>
        <Demo state="pressed" force="pressed">
          <Tabs
            label={t("search.byLabel")}
            tabs={byTabs}
            selected="title"
            onSelect={noop}
          />
        </Demo>
        <Demo state="focus" force="focus">
          <Tabs
            label={t("search.byLabel")}
            tabs={byTabs}
            selected="artist"
            onSelect={noop}
          />
        </Demo>
      </Section>

      <Section title="EmptyState">
        <EmptyState>{t("queue.empty")}</EmptyState>
        <EmptyState>{t("search.noResults")}</EmptyState>
      </Section>

      <Section title="InlineError">
        <Demo state="with retry">
          <InlineError onRetry={noop}>{t("common.offline")}</InlineError>
        </Demo>
        <Demo state="without retry">
          <InlineError>
            {t("queueButton.failed", { reason: "Video unavailable" })}
          </InlineError>
        </Demo>
      </Section>

      <Section title="Sheet">
        <div className={styles.bleed}>
          <Demo state="collapsed">
            <Sheet
              label={t("sheet.nowPlaying")}
              header={nowPlaying}
              expanded={false}
              onExpandedChange={noop}
            >
              {upNext}
            </Sheet>
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="collapsed, pressed" force="pressed">
            <Sheet
              label={t("sheet.nowPlaying")}
              header={nowPlaying}
              expanded={false}
              onExpandedChange={noop}
            >
              {upNext}
            </Sheet>
          </Demo>
        </div>
        <div className={styles.bleed}>
          <Demo state="expanded">
            <Sheet
              label={t("sheet.nowPlaying")}
              header={nowPlaying}
              expanded={sheetOpen}
              onExpandedChange={setSheetOpen}
            >
              {upNext}
              <div className={styles.controls}>
                <IconButton label={t("playback.restart")} icon={<MdReplay />} />
                <IconButton
                  label={t("playback.pause")}
                  icon={<MdPause />}
                  tone="accent"
                />
                <IconButton label={t("playback.skip")} icon={<MdSkipNext />} />
              </div>
            </Sheet>
          </Demo>
        </div>
      </Section>
    </div>
  );
};

export default DevUiPage;
