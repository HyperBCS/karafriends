// YouTube caption language codes, as youtubei.js reports them and the remote
// sends them: "en", "fil", "ckb", "zh-TW", "pt-BR", "fr-CA", "zh-Hant",
// "es-419". yt-dlp names the subtitle file after the code
// (yt-<id>.pt-BR.vtt).
//
// The shape also keeps a code safe as yt-dlp's --sub-langs argument (a regex,
// where a leading "-" means "skip" and "all" means every language) and in a
// file name: letters, digits and inner hyphens only.
//
// No Electron imports, so validate.ts and unit tests can load it.
const CAPTION_CODE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isCaptionCode(code: string): boolean {
  return CAPTION_CODE_RE.test(code) && code.toLowerCase() !== "all";
}
