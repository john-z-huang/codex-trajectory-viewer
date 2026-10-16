import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

function contentTypeFor(target) {
  if (target.endsWith(".html")) return "text/html; charset=utf-8";
  if (target.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (target.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

export async function serveStaticFile(url, response, root) {
  const dist = path.join(root, "dist");
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const target = path.resolve(dist, requested);
  if (!target.startsWith(`${dist}${path.sep}`) && target !== path.join(dist, "index.html")) {
    response.writeHead(404).end();
    return;
  }
  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new Error("not a file");
    response.writeHead(200, { "Content-Type": contentTypeFor(target) });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404).end("Run npm run build to create the web app.");
  }
}
