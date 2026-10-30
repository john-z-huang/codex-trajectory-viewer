import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppLogger } from "./logger.js";
import { isAllowedLogOrigin, readJsonBody, validateBrowserBatch } from "./logger.js";

const MAX_BATCH_BYTES = 64 * 1024;
const MAX_BATCH_EVENTS = 50;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function reject(request: IncomingMessage, response: ServerResponse, status: number, code: string): void {
  request.resume();
  sendJson(response, status, { error: "Log batch rejected", code });
}

export async function handleLogIngest(request: IncomingMessage, response: ServerResponse, logger: AppLogger | undefined): Promise<boolean> {
  if (request.url?.split("?", 1)[0] !== "/api/logs") return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  if (!logger) {
    reject(request, response, 503, "log_write_failed");
    return true;
  }
  if (!isAllowedLogOrigin(request)) {
    reject(request, response, 403, "invalid_origin");
    return true;
  }
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    reject(request, response, 415, "invalid_content_type");
    return true;
  }
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string" && Number(contentLength) > MAX_BATCH_BYTES) {
    reject(request, response, 413, "payload_too_large");
    return true;
  }
  let payload: unknown;
  try { payload = await readJsonBody(request, MAX_BATCH_BYTES); }
  catch (error) {
    const code = error instanceof Error && error.message === "payload_too_large" ? "payload_too_large" : "invalid_json";
    reject(request, response, code === "payload_too_large" ? 413 : 400, code);
    return true;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some((key) => key !== "events")) {
    sendJson(response, 400, { error: "Log batch rejected", code: "invalid_event" });
    return true;
  }
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH_EVENTS) {
    sendJson(response, 400, { error: "Log batch rejected", code: "too_many_events" });
    return true;
  }
  if (!validateBrowserBatch(events)) {
    sendJson(response, 400, { error: "Log batch rejected", code: "invalid_event" });
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    logger.acceptBrowserBatch(events),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!result) {
    sendJson(response, 503, { accepted: 0, duplicate: 0, rejected: events.length, persisted: false, code: "log_write_failed" });
    return true;
  }
  const status = result.rejected > 0 ? (logger.status().healthy ? 429 : 503) : 200;
  sendJson(response, status, { ...result, persisted: result.rejected === 0 });
  return true;
}

export function handleLogHealth(request: IncomingMessage, response: ServerResponse, logger?: AppLogger): boolean {
  if (request.method !== "GET" || request.url?.split("?", 1)[0] !== "/api/logs/health") return false;
  const status = logger?.status();
  sendJson(response, 200, {
    logging: logger ? {
      healthy: status?.healthy ?? false,
      queued: status?.queued ?? 0,
      dropped: status?.dropped ?? 0,
      last_error_code: status?.lastErrorCode ?? null,
    } : { enabled: false, healthy: false, queued: 0, dropped: 0, last_error_code: null },
  });
  return true;
}
