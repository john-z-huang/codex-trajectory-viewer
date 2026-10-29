import { detailRequestScheduler } from "./detail-request-scheduler.js";

export const STALE_SESSION_RESPONSE = Symbol("stale session response");

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
} = {}) {
  return detailRequestScheduler.enqueue(async () => {
    if (signal?.aborted || !isCurrent()) return STALE_SESSION_RESPONSE;
    const response = await fetch(sessionViewUrl(sessionId, params), { cache: "no-store", signal });
    if (!isCurrent()) return STALE_SESSION_RESPONSE;

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // Preserve the HTTP status if a proxy or server returns a non-JSON body.
      }
      if (!isCurrent()) return STALE_SESSION_RESPONSE;
      throw new SessionViewError(response.status, payload?.code, payload?.error ?? payload?.message);
    }

    let value;
    if (responseType === "text") value = await response.text();
    else if (responseType === "blob") value = await response.blob();
    else value = await response.json();
    return isCurrent() ? value : STALE_SESSION_RESPONSE;
  }, { priority });
}
