# Phase B (design system) hand-over

Branch `claude/design-system-5275d5`, branched from master e15f92a, not pushed.

## For C (remote) and D (display)

- Tokens: `src/remocon/tokens.scss` (`@use "<rel>/tokens" as *;` gives `$kf-*` vars and mixins
  `kf-pressed`, `kf-focus-visible`, `kf-focus-ring`); custom properties `--kf-*` on :root via index.scss.
  Display: `src/renderer/tokens.css` (imported by index.css), `--kf-*` with display type sizes
  (label 32, body 36, heading 48, title 64).
- Accent #1cb3ff needs DARK text on it (`$kf-on-accent` #121212). White on accent is 2.4:1.
- Primitives: `import { Button, IconButton, List, ListRow, TextField, Sheet, TopBar, Tabs, EmptyState,
InlineError } from "../components/ui"`. ListRow is an `<li>`: put it in `List` (a `<ul>`, `label` = aria-label).
  ListRow's `trailing` sits outside the pressable part, so buttons can go there. `current` = accent edge + title.
  IconButton requires `label` (aria-label). Sheet: `label` names the region; toggle labels default to
  "Show queue"/"Hide queue" with aria-expanded (what the e2e tests click).
  TopBar renders a `<div>` with an `<h1>`; wrap it in `<header>` in the shell.
- i18n: `import { t, useLanguage } from "../i18n"`. `t()` is a plain function; a language change remounts
  everything under LanguageProvider (inside the query/live providers), so no hook is needed to re-render.
  en.ts defines keys; ja.ts must match (type error otherwise); `{name}` vars are required by t()'s type.
  Karaoke terms in ja: 予約 (queue), 演奏中 (now playing), 機種 (DAM/JOYSOUND filter).
- /dev/ui: `yarn dev` → `http://localhost:5173/remocon/#/dev/ui`. For screenshots from the prod-build fixture:
  `VITE_KARAFRIENDS_DEV_UI=1 yarn build-prod` then `KARAFRIENDS_SCREENSHOTS=1 yarn test:e2e screenshots`
  (tests/e2e/screenshots.spec.ts; add your phase's shots there). Rebuild without the flag afterwards.
- Pressed/focus states for review: wrap a demo in `<div data-demo="pressed|focus">`.
- playwright.config.ts now sets `locale: "en-US"`, since the remote follows navigator.language.

## Merge notes

- `notes/PLAN-product.md`: Prettier realigned the Status table (B row is wider), same as E. Take master's rows,
  re-apply the B row, run prettier.
- E adds CHANGELOG.md; B didn't touch it. Suggested line: "Design tokens, dark background, UI primitives,
  English/Japanese scaffold and the /dev/ui review page for the phone remote."
- App.tsx: the remote's routes moved into a `Shell` route under `<Route path="*">` so /dev/ui renders alone.
- I didn't touch `src/remocon/hooks/useDownloadButtonText.ts` (A1 owns it); its strings are seeded as
  `queueButton.*` keys for C.
