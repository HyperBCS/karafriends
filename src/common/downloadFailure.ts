// Why a download failed, in words for the guest who queued it, and how to
// start the tools that download. The full yt-dlp and ffmpeg output stays in
// the download's log file; a phone gets one of these short reasons.
//
// No Electron imports, so unit tests can load this file under plain Node.

export const REASONS = {
  unavailable: "Video unavailable",
  private: "Private video",
  ageRestricted: "Age-restricted video",
  membersOnly: "Members-only video",
  liveOrPaid: "Live, upcoming or paid video",
  geoBlocked: "Not available in this country",
  botCheck: "YouTube blocked the download",
  timedOut: "Download timed out",
  joysound: "Couldn't get the song from Joysound",
  noTools: "Couldn't get the download tools",
  toolFailedToStart: "Couldn't start the downloader",
  videoProcessing: "Couldn't process the video",
  damSample: "DAM sent a preview instead of the song",
  diskFull: "The karaoke PC's disk is full",
  other: "Download failed",
} as const;

// The reasons that are about the one video (or the PC's disk), not the
// tools: updating them wouldn't help.
const VIDEO_REASONS: readonly string[] = [
  REASONS.unavailable,
  REASONS.private,
  REASONS.ageRestricted,
  REASONS.membersOnly,
  REASONS.liveOrPaid,
  REASONS.geoBlocked,
  REASONS.diskFull,
];

// Whether a DAM video durationSeconds long is a sample DAM sent instead of
// the song, playtimeSeconds long: under 60 % of it. Kept, the sample would
// play every time the song is queued. False when the playtime isn't known,
// or the duration (NaN).
export function isDamSample(
  durationSeconds: number,
  playtimeSeconds: number | null,
): boolean {
  return (
    playtimeSeconds !== null &&
    playtimeSeconds > 0 &&
    durationSeconds < 0.6 * playtimeSeconds
  );
}

// What the display says after a YouTube or Niconico download fails with
// isToolProblem.
export const TOOLS_PROBLEM =
  "YouTube downloads are failing. Check for tool updates in Settings › Advanced.";

// Whether a YouTube or Niconico download that failed for reason points at
// yt-dlp rather than the video: YouTube's bot check (an old yt-dlp, often),
// the tool not starting or not downloading, a timeout, or an error it
// doesn't name.
export function isToolProblem(reason: string): boolean {
  return !VIDEO_REASONS.includes(reason);
}

// A download step that failed: reason is for guests, detail for the log.
export class DownloadFailure extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "DownloadFailure";
  }
}

// The guest-facing reason for err, whatever was thrown.
export function failureReason(err: unknown): string {
  return err instanceof DownloadFailure ? err.reason : REASONS.other;
}

// yt-dlp's errors, most specific first: a private video's error also says
// "Sign in", and many say "unavailable".
const YTDLP_ERRORS: [RegExp, string][] = [
  // No format it can use, the usual sign of an outdated yt-dlp (YouTube
  // changed its player): a tools problem, so the display suggests Update
  // tools. Before "not available", which would call it the video's.
  [/requested format is not available/i, REASONS.other],
  [/no space left on device|errno 28\b|ENOSPC/i, REASONS.diskFull],
  [/confirm you.?re not a bot/i, REASONS.botCheck],
  [/private video/i, REASONS.private],
  [
    /confirm your age|age.?restricted|inappropriate for some users/i,
    REASONS.ageRestricted,
  ],
  [/members.?only|join this channel/i, REASONS.membersOnly],
  [
    /live event|premieres? in|will begin in|requires payment/i,
    REASONS.liveOrPaid,
  ],
  [
    /available in your country|geo.?restrict|blocked it in your country/i,
    REASONS.geoBlocked,
  ],
  [
    /video unavailable|not available|has been removed|been terminated|does not exist|deleted|HTTP Error 404|Incomplete YouTube ID/i,
    REASONS.unavailable,
  ],
];

// The reason for a yt-dlp run that exited non-zero, from the end of its
// output. yt-dlp prints its errors as "ERROR: [youtube] <id>: <message>".
export function ytdlpFailureReason(output: string): string {
  const errorLines = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("ERROR:"))
    .join("\n");
  const text = errorLines || output;
  for (const [pattern, reason] of YTDLP_ERRORS) {
    if (pattern.test(text)) return reason;
  }
  return REASONS.other;
}

// How to start bin with args. A tool can be overridden with any path
// (KARAFRIENDS_YTDLP_PATH, KARAFRIENDS_FFMPEG_PATH), and on Windows a .cmd
// or .bat script can't be spawned directly: Node refuses (EINVAL). Those run
// through cmd.exe, each argument quoted. (Quoted, cmd only expands %VAR%;
// karafriends' arguments are file paths, URLs and checked IDs.)
export function toolCommand(
  bin: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec: string = process.env.ComSpec ?? "cmd.exe",
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) {
    return { file: bin, args: [...args], windowsVerbatimArguments: false };
  }
  const quote = (arg: string) => `"${arg.replace(/"/g, '""')}"`;
  const commandLine = [bin, ...args].map(quote).join(" ");
  return {
    file: comSpec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
