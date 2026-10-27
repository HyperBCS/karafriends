import path from "path";

import isDev from "electron-is-dev";
import express, { Request, Response } from "express";

// Paths whose whole first segment is a Parcel target are already dev server
// paths. Parcel names the remocon bundle remocon.<hash>.js, which isn't one.
const TARGET_PATH = /^\/(remocon|renderer)(\/|$)/;

function remoconReverseProxy(devPort: number) {
  if (isDev) {
    // On dev, we should proxy non-graphql requests to the remocon dev server
    return (req: Request, res: Response, next: () => void) => {
      if (req.path === "/graphql") {
        next();
        return;
      }
      proxyToDevServer(devPort, req, res).catch((error) => {
        console.error(`remocon dev proxy failed for ${req.originalUrl}`, error);
        if (!res.headersSent) {
          res.status(502).send("The Parcel dev server didn't respond");
        }
      });
    };
  } else {
    // On prod, we can just serve up the built remocon bundle
    return express.static(
      path.join(__dirname, "..", "..", "..", "build", "prod", "remocon"),
    );
  }
}

async function proxyToDevServer(devPort: number, req: Request, res: Response) {
  const fetchFromDevServer = (url: string) =>
    fetch(`http://127.0.0.1:${devPort}${url}`, {
      method: req.method,
      headers: Object.keys(req.headers).map((header): [string, string] => [
        header,
        req.headers[header] as string,
      ]),
    });
  const isTargetPath = TARGET_PATH.test(req.path);
  // Page routes (/, /search/...) are the remocon app's index.html.
  const isPageRoute = !isTargetPath && !path.extname(req.path);

  let proxiedRes = await fetchFromDevServer(
    isPageRoute ? `/remocon${req.originalUrl}` : req.originalUrl,
  );

  // Parcel doesn't put the remocon assets in the same place on every machine:
  // /remocon.<hash>.js can be served at that path or under /remocon/. For a
  // missing file Parcel answers with an HTML page instead of a 404, so on that
  // answer, retry under /remocon/.
  if (
    !isTargetPath &&
    !isPageRoute &&
    isHtmlFallback(req.path, proxiedRes.headers.get("content-type"))
  ) {
    await proxiedRes.body?.cancel();
    proxiedRes = await fetchFromDevServer(`/remocon${req.originalUrl}`);
  }

  res.status(proxiedRes.status);
  proxiedRes.headers.forEach((value, name) => res.set(name, value));
  res.send(Buffer.from(await proxiedRes.arrayBuffer()));
}

function isHtmlFallback(requestPath: string, contentType: string | null) {
  return (
    !/\.html?$/.test(requestPath) && (contentType ?? "").startsWith("text/html")
  );
}

export default remoconReverseProxy;
