import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleSessionApi } from "./session-api.js";
import { serveStaticFile } from "./static-files.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { discoverSessions } from "./session-discovery.js";

export function createAppServer(options = {}) {
  const home = options.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sqliteHome = options.sqliteHome ?? process.env.CODEX_SQLITE_HOME ?? home;
  const root = options.root ?? ROOT;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }

    const handled = await handleSessionApi({ request, response, url, home, sqliteHome });
    if (handled) return;
    if (url.pathname.startsWith("/api/")) {
      response.writeHead(404).end();
      return;
    }
    await serveStaticFile(url, response, root);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  createAppServer().listen(port, "127.0.0.1", () => {
    console.log(`Codex trajectory viewer listening on http://127.0.0.1:${port}`);
  });
}
