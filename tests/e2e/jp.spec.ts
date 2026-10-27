import { expect, test } from "./fixtures";

// DAM and Joysound only answer Japanese IPs and need the logins from the
// installed app's config.yaml. Run with KARAFRIENDS_E2E_JP=1.
test.describe("DAM and Joysound", { tag: "@jp" }, () => {
  test.use({ realCredentials: true });

  for (const catalog of ["DAM", "Joysound"]) {
    test(`a ${catalog} title search finds Lemon`, async ({ remote }) => {
      await remote
        .getByRole("link", { name: `Title (${catalog})`, exact: true })
        .click();
      await expect(
        remote.getByRole("heading", { name: "Search by song title" }),
      ).toBeVisible();
      await remote.getByPlaceholder("Start typing...").fill("Lemon");

      const results = remote
        .getByRole("main")
        .getByRole("link")
        .filter({ hasText: "Lemon" });
      await expect(results.first()).toBeVisible({ timeout: 30_000 });
    });
  }
});
