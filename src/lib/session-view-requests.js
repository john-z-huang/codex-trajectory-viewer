import { detailRequestScheduler } from "./detail-request-scheduler.js";
import { browserLogger, createLogId } from "./logger.js";

export const STALE_SESSION_RESPONSE = Symbol("stale session response");

const ROUTES = Object.freeze({
  detail: "sessions_detail",
  window: "sessions_window",
  page: "sessions_page",
  raw: "sessions_raw",
  download: "sessions_download",
  search: "sessions_search",
  history: "sessions_history",
  "history-search": "sessions_history_search",
});

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function serverDuration(response) {
  const value = response.headers?.get?.("server-timing") ?? "";
  const match = /(?:^|,)\s*app;dur=(\d+(?:\.\d+)?)(?:;|,|$)/i.exec(value);
  if (!match) return undefined;
  const milliseconds = Number(match[1]);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.round(milliseconds) : undefined;
}

function requestErrorCode(reason, status) {
  if (status === 409 || reason?.code === "stale_revision") return "stale_revision";
  if (reason?.name === "AbortError") return "aborted";
  return "internal_error";
}

function responseDegraded(value) {
  return Array.isArray(value?.supplement)
    && value.supplement.some((source) => source?.available === false || source?.status === "degraded");
}

export class SessionViewError extends Error {
  constructor(status, code, message) {
    super(message || `会话读取失败（${status}）`);
    this.name = "SessionViewError";
    this.status = status;
    this.code = code || "request_failed";
  }
}

export function sessionViewUrl(sessionId, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  return `/api/sessions/${encodeURIComponent(sessionId)}?${search.toString()}`;
}

/**
 * Run every session-data request through the shared bounded scheduler. The
 * response body is fully consumed inside the scheduled task, so cancellation
 * cannot release its slot while a stale body is still pending.
 */
export function enqueueSessionView(sessionId, params, {
  signal,
  priority = 0,
  isCurrent = () => true,
  responseType = "json",
  operationId = createLogId(),
  tabId,
} = {}) {
  const view = params?.view;
  const route = ROUTES[view] ?? "sessions_detail";
  const queuedAt = monotonicNow();
  let requestStartedAt = null;
  let reported = false;

  function report({ status, outcome, error_code, network_ms, server_ms, request_id }) {
    if (reported) return;
    reported = true;
    browserLogger.log("browser_detail_request", {
      route,
      status,
      queue_ms: Math.max(0, Math.round((requestStartedAt ?? monotonicNow()) - queuedAt)),
      network_ms,
      server_ms,
      outcome,
      error_code,
      operation_id: operationId,
    }, { operation_id: operationId, request_id, tab_id: tabId });
  }

  const task = detailRequestScheduler.enqueue(async () => {
    if (signal?.aborted || !isCurrent()) {
      report({ outcome: signal?.aborted ? "aborted" : "stale", error_code: signal?.aborted ? "aborted" : undefined });
      return STALE_SESSION_RESPONSE;
    }
    requestStartedAt = monotonicNow();
    let status;
    let request_id;
    let server_ms;
    try {
      const headers = { "X-Operation-Id": operationId };
      const response = await fetch(sessionViewUrl(sessionId, params), { cache: "no-store", signal, headers });
      status = response.status;
      request_id = response.headers?.get?.("x-request-id") ?? undefined;
      server_ms = serverDuration(response);
      if (!isCurrent()) {
        report({ status, outcome: "stale", error_code: status === 409 ? "stale_revision" : undefined, network_ms: Math.max(0, Math.round(monotonicNow() - requestStartedAt)), server_ms, request_id });
        return STALE_SESSION_RESPONSE;
      }

      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); }
        catch { /* Preserve the HTTP status if a proxy or server returns a non-JSON body. */ }
        if (!isCurrent()) {
          report({ status, outcome: "stale", error_code: status === 409 ? "stale_revision" : undefined, network_ms: Math.max(0, Math.round(monotonicNow() - requestStartedAt)), server_ms, request_id });
          return STALE_SESSION_RESPONSE;
        }
        report({ status, outcome: status === 409 ? "stale" : "failure", error_code: requestErrorCode(null, status), network_ms: Math.max(0, Math.round(monotonicNow() - requestStartedAt)), server_ms, request_id });
        throw new SessionViewError(response.status, payload?.code, payload?.error ?? payload?.message);
      }

      let value;
      if (responseType === "text") value = await response.text();
      else if (responseType === "blob") value = await response.blob();
      else value = await response.json();
      const network_ms = Math.max(0, Math.round(monotonicNow() - requestStartedAt));
      if (!isCurrent()) {
        report({ status, outcome: "stale", network_ms, server_ms, request_id });
        return STALE_SESSION_RESPONSE;
      }
      report({ status, outcome: responseDegraded(value) ? "degraded" : "success", network_ms, server_ms, request_id });
      return value;
    } catch (reason) {
      report({
        status,
        outcome: reason?.name === "AbortError" ? "aborted" : "failure",
        error_code: requestErrorCode(reason, status),
        network_ms: requestStartedAt === null ? undefined : Math.max(0, Math.round(monotonicNow() - requestStartedAt)),
        server_ms,
        request_id,
      });
      throw reason;
    }
  }, { priority });

  task.promise.catch((reason) => {
    if (reason?.name === "AbortError") report({ outcome: "aborted", error_code: "aborted" });
  });
  return task;
}
