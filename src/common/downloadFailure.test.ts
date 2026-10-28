// Runs on Node's test runner through tsx (yarn test:unit).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DownloadFailure,
  failureReason,
  isDamSample,
  isToolProblem,
  REASONS,
  toolCommand,
  ytdlpFailureReason,
} from "./downloadFailure";

describe("isDamSample", () => {
  test("a video under 60 % of the song is a sample", () => {
    assert.equal(isDamSample(30, 240), true);
    assert.equal(isDamSample(143.9, 240), true);
  });

  test("a video of 60 % of the song or more is the song", () => {
    assert.equal(isDamSample(144, 240), false);
    assert.equal(isDamSample(238.5, 240), false);
    assert.equal(isDamSample(300, 240), false);
  });

  test("without the playtime or the duration, nothing is a sample", () => {
    assert.equal(isDamSample(30, null), false);
    assert.equal(isDamSample(30, 0), false);
    assert.equal(isDamSample(NaN, 240), false);
  });
});

describe("isToolProblem", () => {
  test("a reason about the video is not the tools'", () => {
    for (const reason of [
      REASONS.unavailable,
      REASONS.private,
      REASONS.ageRestricted,
      REASONS.membersOnly,
      REASONS.liveOrPaid,
      REASONS.geoBlocked,
    ]) {
      assert.equal(isToolProblem(reason), false, reason);
    }
  });

  test("the bot check, an unnamed error, or a tool that won't run is", () => {
    for (const reason of [
      REASONS.botCheck,
      REASONS.other,
      REASONS.toolFailedToStart,
      REASONS.noTools,
      REASONS.timedOut,
    ]) {
      assert.equal(isToolProblem(reason), true, reason);
    }
    assert.equal(
      isToolProblem(
        ytdlpFailureReason(
          "ERROR: [youtube] a: Sign in to confirm you're not a bot",
        ),
      ),
      true,
    );
  });
});

describe("ytdlpFailureReason", () => {
  const cases: [string, string][] = [
    [
      "ERROR: [youtube] aaaaaaaaaaa: Video unavailable. This video has been removed by the uploader",
      REASONS.unavailable,
    ],
    [
      "ERROR: [youtube] aaaaaaaaaaa: Private video. Sign in if you've been granted access to this video",
      REASONS.private,
    ],
    [
      "ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm your age. This video may be inappropriate for some users.",
      REASONS.ageRestricted,
    ],
    [
      "ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser",
      REASONS.botCheck,
    ],
    [
      "ERROR: [youtube] aaaaaaaaaaa: Join this channel to get access to members-only content like this video",
      REASONS.membersOnly,
    ],
    [
      "ERROR: [youtube] aaaaaaaaaaa: Video unavailable. The uploader has not made this video available in your country",
      REASONS.geoBlocked,
    ],
    [
      "ERROR: [youtube] aaaaaaaaaaa: This live event will begin in 3 hours.",
      REASONS.liveOrPaid,
    ],
    ["ERROR: [youtube] aaaaaaaaaaa: Premieres in 2 hours", REASONS.liveOrPaid],
    [
      "ERROR: [youtube] aaaaaaaaaaa: This video requires payment to watch.",
      REASONS.liveOrPaid,
    ],
    ["ERROR: [niconico] sm9: HTTP Error 404: Not Found", REASONS.unavailable],
    ["ERROR: unable to write data: [Errno 28] No space left", REASONS.other],
    ["", REASONS.other],
  ];
  for (const [output, reason] of cases) {
    test(`${JSON.stringify(output.slice(0, 50))}: ${reason}`, () => {
      assert.equal(ytdlpFailureReason(output), reason);
    });
  }

  test("goes by the ERROR lines, not the output around them", () => {
    const output = [
      "[youtube] Extracting URL: https://www.youtube.com/watch?v=Private1234",
      "[download] Destination: not available.mp4",
      "ERROR: [youtube] Private1234: Private video. Sign in",
      "",
    ].join("\r\n");
    assert.equal(ytdlpFailureReason(output), REASONS.private);
  });
});

describe("failureReason", () => {
  test("a DownloadFailure's reason, or a generic one", () => {
    assert.equal(
      failureReason(new DownloadFailure(REASONS.timedOut, "15 min")),
      "Download timed out",
    );
    assert.equal(failureReason(new Error("EACCES")), REASONS.other);
    assert.equal(failureReason(-1), REASONS.other);
  });
});

describe("toolCommand", () => {
  test("runs an executable as it is", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      assert.deepEqual(toolCommand("/x/yt-dlp.exe", ["-o", "a b"], platform), {
        file: "/x/yt-dlp.exe",
        args: ["-o", "a b"],
        windowsVerbatimArguments: false,
      });
    }
    // Elsewhere a script runs by its shebang, whatever its name.
    assert.equal(toolCommand("/x/fake.cmd", [], "linux").file, "/x/fake.cmd");
  });

  test("runs a Windows batch script through cmd.exe, quoted", () => {
    assert.deepEqual(
      toolCommand(
        "C:\\Program Files\\fake yt-dlp.CMD",
        ["-S", "res:720,ext:mp4", "-o", 'C:\\tmp dir\\a"b.mp4', "--", "abc"],
        "win32",
        "C:\\Windows\\system32\\cmd.exe",
      ),
      {
        file: "C:\\Windows\\system32\\cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          '""C:\\Program Files\\fake yt-dlp.CMD" "-S" "res:720,ext:mp4" "-o" "C:\\tmp dir\\a""b.mp4" "--" "abc""',
        ],
        windowsVerbatimArguments: true,
      },
    );
  });
});
