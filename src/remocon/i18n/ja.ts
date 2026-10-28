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
  "common.loadMoreFailed": "続きを読み込めませんでした：{reason}",
  "common.offline": "karafriendsに接続できません。Wi-Fiを確認してください。",
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
  "search.placeholder": "曲名・歌手名・動画のURL",
  "search.linkHint":
    "YouTubeやニコニコのURLを貼り付けると、その動画を予約できます。",
  "search.byLabel": "検索方法",
  "search.title": "曲名",
  "search.artist": "歌手名",
  "search.sourceLabel": "機種",
  "search.sourceAll": "すべて",
  "search.results": "検索結果",
  "search.noResults": "見つかりませんでした",
  "search.songCount": "{count}曲",
  "search.failed": "{source}を検索できませんでした：{reason}",
  "search.moreFailed": "{source}の続きを読み込めませんでした：{reason}",

  "song.background": "背景動画",
  "song.addBackground": "YouTubeの動画を背景に流す",
  "song.backgroundLink": "YouTubeのURLまたは動画ID",
  "song.useVideo": "この動画にする",
  "song.removeBackground": "背景動画を外す",

  "video.views": "{count}回再生",
  "video.infoFailed": "動画の情報を取得できませんでした：{reason}",
  "video.niconicoSlow": "ニコニコの動画はダウンロードに時間がかかります。",

  "lyrics.heading": "歌詞",
  "lyrics.captions": "字幕",
  "lyrics.noCaptions": "なし",
  "lyrics.adhoc": "歌詞を貼り付ける",
  "lyrics.adhocPlaceholder":
    "ここに歌詞を貼り付けてください（1行ずつ表示します）",
  "lyrics.adhocHelp":
    "演奏中に予約リストの自分の曲をタップすると、1行ずつ表示できます。",
  "lyrics.sendLine": "タップして次の行を表示",

  "queueButton.song": "予約する",
  "queueButton.guide": "予約する（ガイドボーカル付き）",
  "queueButton.guideMale": "予約する（男性ガイドボーカル）",
  "queueButton.guideFemale": "予約する（女性ガイドボーカル）",
  "queueButton.video": "予約する",
  "queueButton.waiting": "サーバーの応答待ち",
  "queueButton.downloading": "ダウンロード中",
  "queueButton.downloadingPercent": "ダウンロード中 {percent}%",
  "queueButton.finished": "ダウンロード完了",
  "queueButton.queued": "予約しました（あと{eta}）",
  "queueButton.failed": "ダウンロードできませんでした：{reason}",
  "queueButton.error": "予約できませんでした：{reason}",

  "sheet.nowPlaying": "演奏中",
  "sheet.nothingPlaying": "演奏中の曲はありません",
  "sheet.showQueue": "予約リストを開く",
  "sheet.hideQueue": "予約リストを閉じる",
  "sheet.showEmotes": "リアクションを表示",
  "sheet.showControls": "操作ボタンを表示",
  "queue.label": "予約リスト",
  "queue.empty": "予約はありません",
  "queue.queuedBy": "{nickname}さんの予約",
  "queue.remove": "予約を取り消す",
  "queue.moveToTop": "先頭に移動",

  "playback.play": "再生",
  "playback.pause": "一時停止",
  "playback.restart": "最初から",
  "playback.skip": "スキップ",
  "pitch.key": "キー",
  "pitch.lower": "キーを下げる",
  "pitch.raise": "キーを上げる",
  "emotes.edit": "リアクションを変更",
  "emotes.prompt": "表示する絵文字を入力してください",

  "notification.upSoon": "あと約{eta}で「{name}」の番です。",
  "notification.failed": "「{name}」をダウンロードできませんでした：{reason}",

  "history.heading": "履歴",
  "history.empty": "履歴はありません",

  "profile.heading": "プロフィール",
  "profile.firstVisit":
    "ニックネームを決めてください。予約した曲に表示されます。",
  "profile.nickname": "ニックネーム",
  "profile.start": "はじめる",
  "profile.saveNickname": "保存",
  "profile.notifications": "通知",
  "profile.notificationsOn": "通知をオンにする",
  "profile.notificationsAllowed": "オン：順番が近づくとお知らせします。",
  "profile.notificationsBlocked": "オフ：ブラウザの設定で許可してください。",
  "profile.admin": "管理者",
  "profile.adminPassword": "管理者パスワード",
  "profile.signIn": "ログイン",
  "profile.signOut": "ログアウト",
  "profile.signedIn": "管理者としてログイン中",
  "profile.wrongPassword": "パスワードが違います。ホストに確認してください。",
  "profile.noPassword": "管理者パスワードは設定されていません。",
  "profile.tooManyTries":
    "試行回数が多すぎます。1分待ってから再試行してください。",
  "profile.signInFailed": "ログインできませんでした：{reason}",

  "queue.dragToReorder": "ドラッグで並べ替え",
  "queue.moveFailed": "曲を移動できませんでした：{reason}",

  "lyricsMode.label": "テレビの歌詞",
  "lyricsMode.kana": "ふりがな",
  "lyricsMode.romaji": "ローマ字",
  "lyricsMode.both": "両方",
  "lyricsMode.help":
    "JOYSOUNDの曲で使います。曲ごとに曲のページでも変えられます。",
  "guideMelody.label": "ガイドメロディ",
  "guideMelody.help": "JOYSOUNDの曲のみ。",
  "readings.label": "読み方",
  "readings.written": "そのまま",
  "readings.kana": "かな",
  "readings.romaji": "ローマ字",
  "readings.both": "両方",
};
