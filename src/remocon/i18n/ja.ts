// The remote's Japanese strings: the same keys as en.ts (a missing or extra
// key is a type error), in the register of a karaoke room's remote: polite
// but brief. Karaoke terms where they exist: a queued song is 予約, the
// current song is 演奏中. Brand names stay as the brands write them.
import type { Messages } from "./index";

export const ja: Messages = {
  "common.back": "戻る",
  "common.clear": "クリア",
  "common.tryAgain": "再試行",
  "common.loadFailed": "読み込めませんでした：{reason}",
  "common.offline": "karafriendsに接続できません。Wi-Fiを確認してください。",
  "common.downloadFailed":
    "ダウンロードできませんでした。別の動画を選んでください。",
  "common.loading": "読み込み中",
  "common.more": "もっと見る",
  "common.cancel": "キャンセル",
  "common.unknownUser": "ゲスト",

  "source.dam": "DAM",
  "source.joysound": "JOYSOUND",
  "source.youtube": "YouTube",
  "source.niconico": "ニコニコ",

  "language.label": "言語",
  "language.en": "English",
  "language.ja": "日本語",

  "nav.home": "ホーム",
  "nav.history": "履歴",
  "nav.profile": "プロフィール",

  "search.heading": "曲を探す",
  "search.label": "検索",
  "search.byLabel": "検索方法",
  "search.title": "曲名",
  "search.artist": "歌手名",
  "search.sourceLabel": "機種",
  "search.sourceAll": "すべて",
  "search.titleJoysound": "曲名（JOYSOUND）",
  "search.artistJoysound": "歌手名（JOYSOUND）",
  "search.titleDam": "曲名（DAM）",
  "search.artistDam": "歌手名（DAM）",
  "search.bySongTitle": "曲名で検索",
  "search.byArtistName": "歌手名で検索",
  "search.placeholder": "キーワードを入力",
  "search.noResults": "見つかりませんでした",
  "search.addYoutube": "YouTubeの動画を追加",
  "search.addNiconico": "ニコニコの動画を追加",
  "search.youtubePlaceholder": "YouTubeのURLまたは動画ID",
  "search.niconicoPlaceholder": "ニコニコのURLまたは動画ID",
  "search.getVideoInfo": "動画情報を取得",

  "queueButton.song": "予約する",
  "queueButton.video": "予約する",
  "queueButton.waiting": "サーバーの応答待ち…",
  "queueButton.downloading": "ダウンロード中",
  "queueButton.downloadingPercent": "ダウンロード中 {percent}%",
  "queueButton.finished": "ダウンロード完了",

  "sheet.nowPlaying": "演奏中",
  "sheet.showQueue": "予約リストを開く",
  "sheet.hideQueue": "予約リストを閉じる",
  "sheet.showEmotes": "リアクションを表示",
  "sheet.showControls": "操作ボタンを表示",
  "queue.label": "予約リスト",
  "queue.empty": "予約はありません",
  "queue.queuedBy": "{nickname}さんの予約",
  "queue.remove": "予約を取り消す",
  "queue.moveToTop": "先頭に移動",
  "queue.upNext": "次の曲",

  "playback.play": "再生",
  "playback.pause": "一時停止",
  "playback.restart": "最初から",
  "playback.skip": "スキップ",
  "pitch.key": "キー",
  "pitch.lower": "キーを下げる",
  "pitch.raise": "キーを上げる",

  "history.heading": "履歴",
  "history.empty": "履歴はありません",
};
