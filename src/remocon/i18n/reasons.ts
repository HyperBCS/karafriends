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

// downloadFailure.ts's REASONS, which a failed download's entry carries.
const DOWNLOAD_REASONS: Record<string, ReasonKey> = {
  [REASONS.unavailable]: "reason.unavailable",
  [REASONS.private]: "reason.private",
  [REASONS.ageRestricted]: "reason.ageRestricted",
  [REASONS.membersOnly]: "reason.membersOnly",
  [REASONS.liveOrPaid]: "reason.liveOrPaid",
  [REASONS.geoBlocked]: "reason.geoBlocked",
  [REASONS.botCheck]: "reason.botCheck",
  [REASONS.timedOut]: "reason.timedOut",
  [REASONS.joysound]: "reason.joysound",
  [REASONS.noTools]: "reason.noTools",
  [REASONS.toolFailedToStart]: "reason.toolFailedToStart",
  [REASONS.videoProcessing]: "reason.videoProcessing",
  [REASONS.damSample]: "reason.damSample",
  [REASONS.other]: "reason.other",
};

// Word for word as src/main writes them (queueSong, nicoInfo, and the
// Joysound download's guard); i18n.test.ts checks they're still there.
export const SERVER_REASONS: Record<string, ReasonKey> = {
  "Someone is already adding this song": "reason.alreadyAdding",
  "Failed getting video info. Maybe an invalid VideoID?": "reason.nicoInfo",
  "The queue holds too many lyrics already. Try again after a few songs, or without lyrics.":
    "reason.tooManyLyrics",
};

// queueSong's per-guest limit (config.yaml's paxSongQueueLimit).
export const QUEUE_LIMIT =
  /^(.*) already has (\d+) song\(s\) in the queue or downloading$/;

export function reasonText(
  reason: string,
  language: Language = currentLanguage(),
): string {
  const key = DOWNLOAD_REASONS[reason] ?? SERVER_REASONS[reason];
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
