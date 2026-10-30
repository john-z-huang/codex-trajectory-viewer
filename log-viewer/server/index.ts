import { createServer, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverLogs, LogReadError, openLogDownload, readLogPage } from "./log-reader.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
interface Options { logRoot?: string; root?: string }

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function serveStatic(url: URL, response: ServerResponse, root: string): Promise<void> {
  const dist = path.resolve(root, "dist");
  const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  const target = path.resolve(dist, relative);
  if (!target.startsWith(dist + path.sep)) { response.writeHead(404).end(); return; }
  try {
    const [resolvedDist, resolvedTarget] = await Promise.all([realpath(dist), realpath(target)]);
    if (!resolvedTarget.startsWith(resolvedDist + path.sep)) { response.writeHead(404).end(); return; }
    const info = await stat(resolvedTarget);
    if (!info.isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream", "Content-Length": info.size });
    const stream = createReadStream(resolvedTarget);
    response.once("close", () => stream.destroy());
    stream.once("error", () => response.destroy());
    stream.pipe(response);
  } catch { response.writeHead(404).end(); }
}

export function createLogServer(options: Options = {}) {
  const logRoot = options.logRoot ?? process.env.CTV_LOG_ROOT ?? path.join(os.homedir(), ".local", "state", "codex-trajectory-viewer", "logs");
  const root = options.root ?? ROOT;
  return createServer(async (request, response) => {
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => controller.abort());
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      let host: URL;
      try { host = new URL("http://" + (request.headers.host ?? "")); }
      catch { json(response, 403, { error: "仅接受本机请求", code: "invalid_host" }); return; }
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host.hostname) || host.username || host.password) {
        json(response, 403, { error: "仅接受本机请求", code: "invalid_host" }); return;
      }
      if (request.method !== "GET") { request.resume(); response.setHeader("Allow", "GET"); json(response, 405, { error: "日志服务仅支持读取", code: "method_not_allowed" }); return; }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/logs") { json(response, 200, await discoverLogs(logRoot)); return; }
      const match = url.pathname.match(/^\/api\/logs\/([^/]+)(\/download)?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (match[2]) {
          const { file, handle, size } = await openLogDownload(logRoot, id, url.searchParams.get("revision") ?? "", controller.signal);
          if (response.destroyed) { await handle.close(); return; }
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="' + file.name + '"', "Content-Length": size });
          if (!size) { await handle.close(); response.end(); return; }
          const stream = handle.createReadStream({ start: 0, end: size - 1, autoClose: true });
          response.once("close", () => stream.destroy());
          stream.once("error", () => response.destroy());
          stream.pipe(response);
        } else json(response, 200, await readLogPage(logRoot, id, url.searchParams, controller.signal));
        return;
      }
      if (url.pathname.startsWith("/api/")) { json(response, 404, { error: "接口不存在", code: "not_found" }); return; }
      await serveStatic(url, response, root);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof LogReadError) json(response, error.status, { error: error.message, code: error.code });
      else json(response, 500, { error: "日志读取失败", code: "read_error" });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.CTV_LOG_VIEWER_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("CTV_LOG_VIEWER_PORT 必须为 0–65535 的整数");
  const server = createLogServer();
  server.once("error", () => { console.error("日志服务启动失败，请检查端口和配置。"); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    console.log("Codex log viewer listening on http://127.0.0.1:" + (typeof address === "object" && address ? address.port : port));
  });
}
