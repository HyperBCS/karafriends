// The address phones open, as the QR code has it: this computer's LAN
// address, or a custom URL for phones that reach it another way.

// A custom URL typed into Settings › Party: for Tailscale, a port forward or
// a reverse proxy. "host" or "host:port" alone means http. It must be a
// site's root, since the remote asks for /api there. The URL for the QR
// code ("https://karaoke.example.ts.net", the host in lower case and a
// default port left out), or why it can't be one.
export function parseCustomUrl(
  text: string,
): { url: string } | { error: string } {
  const typed = text.trim();
  if (typed === "") return { error: "Type the address phones open." };
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`,
    );
  } catch {
    return {
      error: "That isn't an address. Type it as a phone's browser opens it.",
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http:// or https:// addresses." };
  }
  if (url.hostname === "") {
    return {
      error: "That isn't an address. Type it as a phone's browser opens it.",
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { error: "No user name or password in it." };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return {
      error:
        "Just the site's address, with nothing after the host and port: the remote has to be at its root.",
    };
  }
  return { url: `${url.protocol}//${url.host}` };
}

// What the TV writes under the QR code: the address without "http://",
// which a phone's browser adds, or whole for https.
export function addressText(url: string): string {
  return url.startsWith("http://") ? url.slice("http://".length) : url;
}
