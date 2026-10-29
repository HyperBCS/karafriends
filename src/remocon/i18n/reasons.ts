// The reasons the server writes itself, in English, said in the phone's
// language: "Couldn't download: {reason}" and the like wrap them. Any other
// reason (YouTube's own words, an error message) shows as it came.
import { REASONS } from "../../common/downloadFailure";
import {
  countKey,
  currentLanguage,
  translate,
  type Language,
  type MessageKey,
} from "./index";

// The keys for the reasons below: those without a {variable}.
type ReasonKey = Exclude<
  Extract<MessageKey, `reason.${string}`>,
  `reason.queueLimit${string}`
>;

// downloadFailure.ts's REASONS, which a failed download's entry carries:
// each one's key is "reason.<its name>".
type DownloadReasonKey = `reason.${keyof typeof REASONS}`;
// A type error here: en.ts lacks a key for a reason added to REASONS.
const everyReasonHasAKey: ReasonKey = "" as DownloadReasonKey;
void everyReasonHasAKey;
const DOWNLOAD_REASONS = new Map<string, DownloadReasonKey>(
  Object.entries(REASONS).map(
    ([name, reason]) =>
      [reason, `reason.${name}` as DownloadReasonKey] as const,
  ),
);

// Word for word as src/main writes them (queueSong, nicoInfo, and the
// Joysound download's guard); i18n.test.ts checks they're still there.
export const SERVER_REASONS: Record<string, ReasonKey> = {
  "Someone is already adding this song": "reason.alreadyAdding",
  "Failed getting video info. Maybe an invalid VideoID?": "reason.nicoInfo",
  "The queue holds too many lyrics already. Try again after a few songs, or without lyrics.":
    "reason.tooManyLyrics",
  "DAM isn't available on this karaoke PC": "reason.damOff",
  "Joysound isn't available on this karaoke PC": "reason.joysoundOff",
};

// queueSong's per-guest limit (config.yaml's paxSongQueueLimit).
export const QUEUE_LIMIT =
  /^(.*) already has (\d+) song\(s\) in the queue or downloading$/;

export function reasonText(
  reason: string,
  language: Language = currentLanguage(),
): string {
  const key = DOWNLOAD_REASONS.get(reason) ?? SERVER_REASONS[reason];
  if (key) return translate(language, key);
  const limit = reason.match(QUEUE_LIMIT);
  if (limit) {
    const count = Number(limit[2]);
    return translate(language, countKey("reason.queueLimit", count, language), {
      nickname: limit[1],
      count,
    });
  }
  return reason;
}
