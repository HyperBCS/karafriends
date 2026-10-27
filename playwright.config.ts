import { defineConfig, devices } from "@playwright/test";

// Smoke tests for the production build (run `yarn build-prod` first). Tags:
//   @net  needs the internet (YouTube); left out of CI, where downloads flake.
//   @jp   needs a Japanese IP and DAM/Joysound logins; runs only with
//         KARAFRIENDS_E2E_JP=1.
const runJapanOnlyTests = process.env.KARAFRIENDS_E2E_JP === "1";

export default defineConfig({
  testDir: "tests/e2e",
  // Every test launches its own copy of the app, whose display window opens
  // fullscreen, so run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  grepInvert: runJapanOnlyTests ? undefined : /@jp/,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // The remote runs in Chromium as a phone.
    ...devices["Pixel 7"],
    // The remote picks its language from the browser's (src/remocon/i18n),
    // and the tests read its English.
    locale: "en-US",
    launchOptions: { args: ["--mute-audio"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
