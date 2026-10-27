// The environment for yt-dlp: the main process's, minus http_proxy. YouTube
// and Niconico don't need the proxy (config.yaml's proxy, for DAM and
// Joysound, is a tunnel, not an env var).
//
// It's a copy: process.env keeps http_proxy for ffmpeg and anything else
// started later. Windows env names ignore case, so every spelling goes.
//
// No Electron imports, so unit tests can load it.
export function envWithoutHttpProxy(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.toLowerCase() === "http_proxy") delete copy[key];
  }
  return copy;
}
