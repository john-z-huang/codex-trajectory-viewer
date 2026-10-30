const MAX_BATCH_EVENTS = 50;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_QUEUE_EVENTS = 200;
const MAX_QUEUE_BYTES = 256 * 1024;
const FLUSH_AFTER_EVENTS = 20;
const FLUSH_AFTER_MS = 2000;

const ENUMS = {
  route: ["sessions_list", "sessions_detail", "sessions_window", "sessions_page", "sessions_raw", "sessions_download", "sessions_search", "sessions_history", "sessions_history_search", "static", "unknown_api", "method_not_allowed", "logs_ingest"],
  outcome: ["sent", "aborted", "failed", "success", "failure", "cancelled", "stale", "degraded", "rejected", "dispatched", "queued"],
  error_type: ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "RolloutReaderError", "SupplementRevisionError", "SQLiteError", "NetworkError", "UnknownError"],
  error_code: ["internal_error", "read_error", "stale_revision", "invalid_json", "invalid_event", "invalid_origin", "invalid_content_type", "payload_too_large", "too_many_events", "rate_limited", "deduplicated", "log_write_failed", "log_root_unsafe", "sqlite_unavailable", "sqlite_schema", "sqlite_corrupt", "sqlite_permission", "aborted", "queue_full", "listen_failed", "unhandled_rejection", "window_error", "render_error", "recoverable_render_error"],
  action: ["open", "reactivate", "close", "switch", "filter", "page", "jump", "search", "expand", "collapse", "fragment", "start", "success", "failure", "cancel", "precheck", "dispatch", "stream_start", "stream_end", "stream_abort", "local_dispatch"],
  data_source: ["jsonl", "sqlite", "list", "history"],
  ui_result: ["success", "failure", "cancelled", "stale", "degraded", "dispatched"],
};

const EVENT_FIELDS = Object.freeze({
  browser_refresh: ["action", "outcome", "duration_ms", "result_count", "operation_id"],
  browser_list_request: ["status", "duration_ms", "queue_ms", "network_ms", "server_ms", "outcome", "error_code", "result_count", "operation_id"],
  browser_detail_request: ["route", "status", "queue_ms", "network_ms", "server_ms", "outcome", "error_code", "operation_id"],
  browser_tab: ["action", "tab_id", "operation_id"],
  browser_source: ["action", "data_source", "tab_id", "operation_id"],
  browser_filter: ["data_source", "query_length", "result_count", "hidden_count", "operation_id"],
  browser_navigation: ["action", "data_source", "query_length", "result_count", "page", "line", "offset", "count", "outcome", "operation_id"],
  browser_raw: ["action", "data_source", "page", "line", "offset", "outcome", "operation_id"],
  browser_copy: ["action", "data_source", "count", "outcome", "operation_id"],
  browser_download: ["action", "data_source", "line", "offset", "count", "outcome", "operation_id"],
  browser_error: ["error_type", "error_code", "action", "operation_id"],
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_TYPES = new Set(ENUMS.error_type);

export function createLogId() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto?.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeValue(field, value) {
  if (field === "operation_id" || field === "request_id" || field === "client_id" || field === "tab_id" || field === "event_id") {
    return typeof value === "string" && ID_RE.test(value) ? value : undefined;
  }
  if (["route", "outcome", "error_type", "error_code", "action", "data_source"].includes(field)) {
    const setName = field === "action" ? "action" : field;
    return typeof value === "string" && ENUMS[setName]?.includes(value) ? value : undefined;
  }
  if (["status", "duration_ms", "queue_ms", "network_ms", "server_ms", "result_count", "query_length", "hidden_count", "page", "line", "offset", "count"].includes(field)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    const safe = Math.min(Math.trunc(value), 1_000_000_000);
    if (field === "status" && (safe < 100 || safe > 599)) return undefined;
    return safe;
  }
  return undefined;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function createBrowserLogger({
  fetchImpl = (...args) => globalThis.fetch(...args),
  sendBeacon = (url, body) => globalThis.navigator?.sendBeacon?.(url, body) ?? false,
  clock = () => new Date(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
  AbortControllerImpl = globalThis.AbortController,
  requestTimeoutMs = 2000,
  enabled = true,
} = {}) {
  const clientId = createLogId();
  const queue = [];
  let queueBytes = 0;
  let sequence = 0;
  let timer = null;
  let inFlight = null;
  let activeAttempt = null;
  const retryDelays = new Map();
  let dropped = 0;
  let isEnabled = enabled;
  let disposed = false;

  function batchForQueue() {
    const batch = [];
    let body = "{\"events\":[]}";
    for (const item of queue) {
      if (batch.length >= MAX_BATCH_EVENTS) break;
      const candidate = [...batch, item.event];
      const candidateBody = JSON.stringify({ events: candidate });
      if (utf8Bytes(candidateBody) > MAX_BATCH_BYTES) break;
      batch.push(item.event);
      body = candidateBody;
    }
    return { events: batch, body };
  }

  function removeEvents(events) {
    const ids = new Set(events.map((event) => event.event_id));
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (!ids.has(queue[index].event.event_id)) continue;
      queueBytes -= queue[index].bytes;
      queue.splice(index, 1);
    }
  }

  function scheduleFlush() {
    if (disposed || !isEnabled || !queue.length || inFlight) return;
    if (queue.length >= FLUSH_AFTER_EVENTS) {
      void flush();
      return;
    }
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, FLUSH_AFTER_MS);
  }

  function log(eventName, fields = {}, context = {}) {
    if (disposed || !isEnabled) return false;
    const allowed = EVENT_FIELDS[eventName];
    if (!Object.hasOwn(EVENT_FIELDS, eventName) || !Array.isArray(allowed)) return false;
    const event = {
      event: eventName,
      event_id: createLogId(),
      client_id: clientId,
      client_time: clock().toISOString(),
      client_seq: ++sequence,
    };
    for (const name of ["operation_id", "request_id", "tab_id"]) {
      const value = safeValue(name, context[name] ?? fields[name]);
      if (value) event[name] = value;
    }
    for (const name of allowed) {
      const value = safeValue(name, fields[name]);
      if (value !== undefined) event[name] = value;
    }
    const bytes = utf8Bytes(JSON.stringify(event));
    if (bytes > MAX_BATCH_BYTES) { dropped += 1; return false; }
    while (queue.length >= MAX_QUEUE_EVENTS || queueBytes + bytes > MAX_QUEUE_BYTES) {
      const lowest = queue.findIndex((item) => item.event.event !== "browser_error");
      if (lowest < 0 || eventName !== "browser_error") { dropped += 1; return false; }
      const [removed] = queue.splice(lowest, 1);
      queueBytes -= removed.bytes;
      dropped += 1;
    }
    queue.push({ event, bytes });
    queueBytes += bytes;
    scheduleFlush();
    return true;
  }

  function retryDelay(delayMs) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new Error("logger_disposed")); return; }
      const timerId = setTimer(() => {
        retryDelays.delete(timerId);
        resolve();
      }, delayMs);
      retryDelays.set(timerId, () => reject(new Error("logger_disposed")));
    });
  }

  async function sendBatch(batch, keepalive = false) {
    if (!batch.events.length) return true;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (disposed) return false;
      const controller = new AbortControllerImpl();
      let rejectAttempt;
      let timeoutTimer;
      const stopped = new Promise((_, reject) => { rejectAttempt = reject; });
      activeAttempt = { controller, reject: rejectAttempt, timeoutTimer: null };
      const request = Promise.resolve().then(async () => {
        const response = await fetchImpl("/api/logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: batch.body,
          keepalive,
          signal: controller.signal,
        });
        let acknowledgement = null;
        try { acknowledgement = await response.json(); } catch { /* A missing acknowledgement is retryable. */ }
        return { response, acknowledgement };
      });
      const timedOut = new Promise((_, reject) => {
        timeoutTimer = setTimer(() => {
          controller.abort();
          reject(new Error("request_timeout"));
        }, requestTimeoutMs);
        activeAttempt.timeoutTimer = timeoutTimer;
      });
      try {
        const { response, acknowledgement } = await Promise.race([request, stopped, timedOut]);
        if (disposed) return false;
        if (response.ok && acknowledgement?.persisted === true) {
          removeEvents(batch.events);
          return true;
        }
        if (!response.ok && response.status < 500 && response.status !== 429 && response.status !== 408) {
          removeEvents(batch.events);
          dropped += batch.events.length;
          return false;
        }
        lastError = new Error("server_rejected_batch");
      } catch {
        if (disposed) return false;
        lastError = new Error("transport_unavailable");
      } finally {
        if (timeoutTimer !== undefined) clearTimer(timeoutTimer);
        if (activeAttempt?.controller === controller) activeAttempt = null;
      }
      if (attempt < 2) {
        try { await retryDelay(200 * (attempt + 1)); }
        catch { return false; }
      }
    }
    if (disposed) return false;
    removeEvents(batch.events);
    dropped += batch.events.length;
    void lastError;
    return false;
  }

  function flush({ keepalive = false } = {}) {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (disposed || !isEnabled) return Promise.resolve(false);
    if (inFlight) return inFlight;
    const batch = batchForQueue();
    if (!batch.events.length) return Promise.resolve(true);
    inFlight = sendBatch(batch, keepalive).finally(() => {
      inFlight = null;
      if (!disposed) scheduleFlush();
    });
    return inFlight;
  }

  function flushOnPageHide() {
    if (disposed || !isEnabled || !queue.length || inFlight) return false;
    if (timer !== null) { clearTimer(timer); timer = null; }
    const batch = batchForQueue();
    if (!batch.events.length) return false;
    const blob = new Blob([batch.body], { type: "application/json" });
    let queued = false;
    try { queued = Boolean(sendBeacon("/api/logs", blob)); } catch { queued = false; }
    if (queued) removeEvents(batch.events);
    else void flush({ keepalive: true });
    return queued;
  }

  function close() {
    if (disposed) return inFlight ?? Promise.resolve(false);
    disposed = true;
    if (timer !== null) { clearTimer(timer); timer = null; }
    for (const [timerId, cancel] of retryDelays) {
      clearTimer(timerId);
      cancel();
    }
    retryDelays.clear();
    if (activeAttempt) {
      activeAttempt.controller.abort();
      activeAttempt.reject(new Error("logger_disposed"));
      if (activeAttempt.timeoutTimer !== null) clearTimer(activeAttempt.timeoutTimer);
      activeAttempt = null;
    }
    dropped += queue.length;
    queue.length = 0;
    queueBytes = 0;
    return inFlight ?? Promise.resolve(false);
  }

  function enable() {
    if (disposed) return false;
    isEnabled = true;
    return true;
  }

  return {
    log,
    flush,
    flushOnPageHide,
    close,
    enable,
    status: () => ({ queued: queue.length, queuedBytes: queueBytes, dropped, inFlight: Boolean(inFlight), enabled: isEnabled, disposed }),
    clientId,
  };
}

export function safeBrowserError(error) {
  const name = error && typeof error === "object" && typeof error.name === "string" ? error.name : "UnknownError";
  return { error_type: ERROR_TYPES.has(name) ? name : "UnknownError" };
}

export const browserLogger = createBrowserLogger({ enabled: false });

const lifecycleKey = Symbol.for("codex-trajectory-viewer.logger-lifecycle");
export function installBrowserLoggerLifecycle() {
  if (!globalThis.window || globalThis[lifecycleKey]) return;
  globalThis[lifecycleKey] = true;
  globalThis.document?.addEventListener("visibilitychange", () => {
    if (globalThis.document.visibilityState === "hidden") void browserLogger.flush({ keepalive: true });
  });
  globalThis.window.addEventListener("pagehide", () => browserLogger.flushOnPageHide());
}

const errorHandlersKey = Symbol.for("codex-trajectory-viewer.logger-error-handlers");
export function installBrowserErrorHandlers() {
  if (!globalThis.window || globalThis[errorHandlersKey]) return;
  globalThis[errorHandlersKey] = true;
  globalThis.window.addEventListener("error", () => {
    browserLogger.log("browser_error", { error_type: "UnknownError", error_code: "window_error", action: "failure" });
  });
  globalThis.window.addEventListener("unhandledrejection", () => {
    browserLogger.log("browser_error", { error_type: "UnknownError", error_code: "unhandled_rejection", action: "failure" });
  });
}

let initialized = false;
export function initializeBrowserLogger() {
  if (initialized) return false;
  if (!browserLogger.enable()) return false;
  initialized = true;
  installBrowserLoggerLifecycle();
  installBrowserErrorHandlers();
  return true;
}
