// The remote's theme (the settings' Theme): light, dark, or auto, which
// follows the phone's light or dark mode, also when it changes. Kept in
// localStorage ("theme"), auto until the guest picks. It shows as
// data-theme="light" | "dark" on <html>, which picks the tokens' colors
// (tokens.scss).
import { getItem, setItem } from "../common/storage";

export type Theme = "light" | "dark" | "auto";
export const THEMES: readonly Theme[] = ["light", "dark", "auto"];
const THEME_KEY = "theme";

const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

const saved = getItem(THEME_KEY);
let current: Theme = THEMES.find((theme) => theme === saved) ?? "auto";

function apply() {
  document.documentElement.dataset.theme =
    current === "auto" ? (darkMode.matches ? "dark" : "light") : current;
}

export const currentTheme = (): Theme => current;

export function saveTheme(theme: Theme) {
  setItem(THEME_KEY, theme);
  current = theme;
  apply();
}

// On import, before the first render, so the page never shows the other
// theme first.
apply();
darkMode.addEventListener("change", apply);
