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
  geoBlocked: "Not available in this country",
  botCheck: "YouTube blocked the download",
  timedOut: "Download timed out",
  joysound: "Couldn't get the song from Joysound",
  noTools: "Couldn't get the download tools",
  toolFailedToStart: "Couldn't start the downloader",
  videoProcessing: "Couldn't put the video together",
  other: "Download failed",
} as const;

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
  [/confirm you.?re not a bot/i, REASONS.botCheck],
  [/private video/i, REASONS.private],
  [
    /confirm your age|age.?restricted|inappropriate for some users/i,
    REASONS.ageRestricted,
  ],
  [/members.?only|join this channel/i, REASONS.membersOnly],
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
