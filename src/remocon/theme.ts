// The remote's theme (the profile's Theme): light, dark, or auto, which
// follows the phone's light or dark mode, also when it changes. Kept in
// localStorage ("theme"), auto until the guest picks. It shows as
// data-theme="light" | "dark" on <html>, which picks the tokens' colors
// (tokens.scss).
export type Theme = "light" | "dark" | "auto";
export const THEMES: readonly Theme[] = ["light", "dark", "auto"];
const THEME_KEY = "theme";

const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

let current: Theme = "auto";
try {
  const saved = localStorage.getItem(THEME_KEY);
  current = THEMES.find((theme) => theme === saved) ?? "auto";
} catch {
  // Storage blocked: auto.
}

function apply() {
  document.documentElement.dataset.theme =
    current === "auto" ? (darkMode.matches ? "dark" : "light") : current;
}

export const currentTheme = (): Theme => current;

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not saved; it still applies until the page reloads.
  }
  current = theme;
  apply();
}

// On import, before the first render, so the page never shows the other
// theme first.
apply();
darkMode.addEventListener("change", apply);
