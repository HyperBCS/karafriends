// The remote's languages: English and Japanese, without a library.
//
//   t("queue.empty")                          "The queue is empty"
//   t("queue.queuedBy", { nickname: "ken" })  "Queued by ken"
//
// t() is a plain function, so it works in components and hooks alike. It
// reads the current language, which LanguageProvider sets; when the language
// changes, LanguageProvider remounts everything under it, so every t() call
// renders again. That resets
// component state below it, which is fine for a toggle used once a party.
//
// The language is kept in localStorage ("language"). Without one, a phone
// set to Japanese gets Japanese and every other phone gets English.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { en } from "./en";
import { ja } from "./ja";

export type Language = "en" | "ja";
export const LANGUAGES: readonly Language[] = ["en", "ja"];

type English = typeof en;
export type MessageKey = keyof English;
// What every dictionary must be: exactly en.ts's keys.
export type Messages = { readonly [K in MessageKey]: string };

// The {names} in a string.
type Placeholders<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | Placeholders<Rest>
    : never;
export type MessageVars<K extends MessageKey> = Record<
  Placeholders<English[K]>,
  string | number
>;
// t()'s vars: required when the English string has a {name}, else none.
type VarsArg<K extends MessageKey> = [Placeholders<English[K]>] extends [never]
  ? []
  : [vars: MessageVars<K>];

const DICTIONARIES: Record<Language, Messages> = { en, ja };

export const STORAGE_KEY = "language";

// The language to start in: the saved one, else the phone's.
export function pickLanguage(
  saved: string | null,
  navigatorLanguage: string | undefined,
): Language {
  if (saved === "en" || saved === "ja") return saved;
  return navigatorLanguage?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function translate<K extends MessageKey>(
  language: Language,
  key: K,
  ...args: VarsArg<K>
): string {
  const text = DICTIONARIES[language][key];
  const values = (args as [Record<string, string | number>?])[0];
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

function initialLanguage(): Language {
  let saved: string | null = null;
  try {
    saved = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    // Storage blocked (a private tab on an old iPhone): use the phone's.
  }
  return pickLanguage(saved, globalThis.navigator?.language);
}

let current: Language = initialLanguage();

export function t<K extends MessageKey>(key: K, ...vars: VarsArg<K>): string {
  return translate(current, key, ...vars);
}

type LanguageState = {
  language: Language;
  setLanguage: (language: Language) => void;
};

const LanguageContext = createContext<LanguageState | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setState] = useState(current);

  const setLanguage = useCallback((next: Language) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved; it still applies until the page reloads.
    }
    // Before the render, so t() returns the new language during it.
    current = next;
    setState(next);
  }, []);

  // For screen readers, and so phones draw the Japanese forms of the CJK
  // characters Chinese and Korean share.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // (A .ts file, so no JSX.) The key remounts the children in the new
  // language.
  return React.createElement(
    LanguageContext.Provider,
    { value: { language, setLanguage } },
    React.createElement(React.Fragment, { key: language }, children),
  );
}

export function useLanguage(): LanguageState {
  const state = useContext(LanguageContext);
  if (!state) throw new Error("useLanguage() needs a LanguageProvider");
  return state;
}
