import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { handleSessionApi } from "./session-api.js";
import { RolloutReaderError, RolloutReaderStore } from "./rollout-reader.js";
import { serveStaticFile } from "./static-files.js";
import { classifySafeError, createFileLogger, routeForRequest, type AppLogger } from "./logger.js";
import { handleLogHealth, handleLogIngest } from "./log-receiver.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { discoverSessions } from "./session-discovery.js";

interface AppServerOptions {
  home?: string;
  sqliteHome?: string;
  root?: string;
  logger?: AppLogger;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestContext(request: IncomingMessage, response: ServerResponse, logger?: AppLogger, url?: URL) {
  if (!logger || url?.pathname.startsWith("/api/logs")) return null;
  const route = routeForRequest(url?.pathname ?? "/", url?.searchParams.get("view") ?? null, request.method ?? "GET");
  const headerOperation = request.headers["x-operation-id"];
  const operation = typeof headerOperation === "string" ? headerOperation : url?.searchParams.get("operation_id");
  const operationId = typeof operation === "string" && UUID_RE.test(operation) ? operation : undefined;
  const requestId = randomUUID();
  const context = { request_id: requestId, operation_id: operationId };
  const startedAt = performance.now();
  let byteCount = 0;
  let terminal = false;
  const addBytes = (chunk: unknown) => {
    if (typeof chunk === "string") byteCount += Buffer.byteLength(chunk);
    else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) byteCount += chunk.byteLength;
  };
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  const originalWriteHead = response.writeHead.bind(response);
  (response as any).write = (chunk: unknown, ...args: unknown[]) => {
    addBytes(chunk);
    return (originalWrite as any)(chunk, ...args);
  };
  (response as any).end = (chunk?: unknown, ...args: unknown[]) => {
    if (chunk !== undefined) addBytes(chunk);
    return (originalEnd as any)(chunk, ...args);
  };
  (response as any).writeHead = (...args: unknown[]) => {
    if (!response.headersSent) {
      const serverMs = Math.max(0, Math.round(performance.now() - startedAt));
      response.setHeader("X-Request-Id", requestId);
      response.setHeader("Server-Timing", `app;dur=${serverMs}`);
    }
    return (originalWriteHead as any)(...args);
  };
  const finish = (outcome: "sent" | "aborted" | "failed") => {
    if (terminal) return;
    terminal = true;
    const status = response.statusCode;
    const classification = status === 409 ? "expected_stale" : status >= 500 ? "server_error" : status >= 400 ? "client_error" : "normal";
    const event = outcome === "aborted" ? "http_request_aborted" : outcome === "failed" || status >= 500 ? "http_request_failed" : "http_request_terminal";
    logger.emit(event, {
      route,
      status,
      bytes: byteCount,
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      outcome,
      classification,
    }, context);
  };
  response.once("finish", () => finish("sent"));
  response.once("close", () => finish(response.writableFinished ? "sent" : "aborted"));
  response.once("error", () => finish("failed"));
  request.once("aborted", () => finish("aborted"));
  return { context, route };
}

export function createAppServer(options: AppServerOptions = {}) {
  const home = options.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const sqliteHome = options.sqliteHome ?? process.env.CODEX_SQLITE_HOME ?? home;
  const root = options.root ?? ROOT;
  const rolloutReader = new RolloutReaderStore(home);
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let context: ReturnType<typeof requestContext> = null;
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "no-store");
      context = requestContext(request, response, options.logger, url);
      if (url.pathname === "/api/logs/health" && request.method === "GET") {
        handleLogHealth(request, response, options.logger);
        return;
      }
      if (url.pathname === "/api/logs" && request.method === "POST") {
        await handleLogIngest(request, response, options.logger);
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }

      const handled = await handleSessionApi({ request, response, url, home, sqliteHome, reader: rolloutReader, logger: options.logger, requestContext: context?.context });
      if (handled) return;
      if (url.pathname.startsWith("/api/")) {
        response.writeHead(404).end();
        return;
      }
      await serveStaticFile(url, response, root);
    } catch (error) {
      if (options.logger && context) {
        const safe = classifySafeError(error);
        if (safe.error_type === "AbortError") options.logger.emit("request_cancelled", { route: context.route }, context.context);
        else options.logger.emit("request_processing_error", { route: context.route, ...safe }, context.context);
      }
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof RolloutReaderError) {
        response.writeHead(error.status, { "Content-Type": "application/json; charset=utf-8" })
          .end(JSON.stringify({ error: error.message, code: error.code }));
        return;
      }
      if (error instanceof Error && error.name === "AbortError") return;
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: "Internal server error" }));
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  const configuredLevel = process.env.CTV_LOG_LEVEL;
  const minLevel = configuredLevel === "debug" || configuredLevel === "warn" || configuredLevel === "error" ? configuredLevel : "info";
  const logger = createFileLogger({ minLevel });
  const server = createAppServer({ logger });
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  server.once("error", (error) => {
    const safe = classifySafeError(error);
    logger.emit("listen_failed", { ...safe, error_code: "listen_failed" });
    process.exitCode = 1;
    void logger.close();
  });
  server.once("close", () => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    logger.emit("server_shutdown");
    void logger.close();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close();
      shutdownTimer ??= setTimeout(() => server.closeAllConnections(), 2000);
      shutdownTimer.unref();
    });
  }
  server.listen(port, "127.0.0.1", () => {
    logger.emit("server_start");
    console.log(`Codex trajectory viewer listening on http://127.0.0.1:${port}`);
  });
}
