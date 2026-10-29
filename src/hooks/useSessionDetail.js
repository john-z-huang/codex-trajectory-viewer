import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRolloutPageCache } from "../lib/rollout-page-cache.js";
import { projectRolloutLines } from "../lib/rollout.js";
import { enqueueSessionView, SessionViewError, STALE_SESSION_RESPONSE } from "../lib/session-view-requests.js";

function cancelRequest(ref) {
  const current = ref.current;
  ref.current = null;
  if (!current) return;
  current.controller?.abort();
  current.task?.cancel();
}

function isStaleRevision(error) {
  return error instanceof SessionViewError && (error.status === 409 || error.code === "stale_revision");
}

function boundedLine(line, totalLines) {
  if (totalLines <= 0) return 0;
  return Math.max(1, Math.min(totalLines, Number.isSafeInteger(line) ? line : 1));
}

function pageStart(line, totalLines, pageSize) {
  if (totalLines <= 0) return 0;
  const safeLine = boundedLine(line, totalLines);
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 32;
  return Math.floor((safeLine - 1) / size) * size + 1;
}

function pageEnd(start, totalLines, pageSize) {
  if (totalLines <= 0) return 0;
  return Math.min(totalLines, start + pageSize - 1);
}

function validateWindow(value) {
  if (!value || !value.rollout || !Array.isArray(value.lines) || typeof value.rollout.revision !== "string") {
    throw new Error("会话窗口响应格式无效");
  }
}

function metadataFromWindow(value) {
  const { lines: _lines, rollout: _rollout, ...metadata } = value;
  return metadata;
}

function projectPage(cache, sessionId, rollout, lines) {
  const start = Number.isSafeInteger(rollout?.startLine) ? rollout.startLine : (lines[0]?.lineNumber ?? 0);
  const entries = projectRolloutLines(lines, { revision: rollout.revision, sessionId });
  if (!cache.set(rollout.revision, start, entries)) throw new Error("当前记录页超出本地缓存预算");
  const cached = cache.get(rollout.revision, start);
  if (!cached) throw new Error("无法缓存当前记录页");
  return { start, entries: cached };
}

export function useSessionDetail(sessionId, refreshVersion, {
  panelId = sessionId,
  active = true,
  onRequestStart,
  onRequestSettled,
} = {}) {
  const [detail, setDetail] = useState(null);
  const [rollout, setRollout] = useState(null);
  const [entries, setEntries] = useState([]);
  const [currentLine, setCurrentLine] = useState(1);
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);

  const cacheRef = useRef(null);
  if (!cacheRef.current) cacheRef.current = createRolloutPageCache();
  const generationRef = useRef(0);
  const activeRef = useRef(active);
  const callbacksRef = useRef({ onRequestStart, onRequestSettled });
  const windowRequestRef = useRef(null);
  const pageRequestRef = useRef(null);
  const searchRequestRef = useRef(null);
  const historyRequestRef = useRef(null);
  const historyGenerationRef = useRef(0);
  const currentRolloutRef = useRef(null);
  const entriesRef = useRef(entries);
  const anchorLineRef = useRef(1);
  const searchOperationRef = useRef(0);

  activeRef.current = active;
  callbacksRef.current = { onRequestStart, onRequestSettled };
  entriesRef.current = entries;
  currentRolloutRef.current = rollout;

  const cancelPage = useCallback(() => cancelRequest(pageRequestRef), []);
  const cancelSearch = useCallback(() => {
    searchOperationRef.current += 1;
    cancelRequest(searchRequestRef);
    setSearchLoading(false);
  }, []);

  useLayoutEffect(() => {
    for (const ref of [windowRequestRef, pageRequestRef, searchRequestRef, historyRequestRef]) {
      ref.current?.task?.setPriority(active ? 1 : 0);
    }
  }, [active]);

  const applyWindow = useCallback((value, requestedLine, forceClear = false) => {
    validateWindow(value);
    const previousRevision = currentRolloutRef.current?.revision ?? null;
    const nextRevision = value.rollout.revision;
    if (forceClear || (previousRevision !== null && previousRevision !== nextRevision)) cacheRef.current.clear();
    const page = projectPage(cacheRef.current, sessionId, value.rollout, value.lines);
    currentRolloutRef.current = value.rollout;
    setRollout(value.rollout);
    setDetail(metadataFromWindow(value));
    setEntries(page.entries);
    const anchor = boundedLine(requestedLine, value.rollout.totalLines ?? 0);
    anchorLineRef.current = anchor || 1;
    setCurrentLine(anchor);
    setPageLoading(false);
    setLoading(false);
    setError("");
    return true;
  }, [sessionId]);

  const runWindow = useCallback(async (line, generation, { notify = false, forceClear = false, preserveSearch = false } = {}) => {
    cancelRequest(pageRequestRef);
    if (!preserveSearch) cancelSearch();
    cancelRequest(windowRequestRef);
    const controller = new AbortController();
    const token = Symbol("window request");
    const requestedLine = Math.max(1, Number.isSafeInteger(line) ? line : 1);
    const isCurrent = () => generationRef.current === generation && windowRequestRef.current?.token === token;
    if (notify) callbacksRef.current.onRequestStart?.(refreshVersion, panelId, token);
    setPageLoading(true);
    const task = enqueueSessionView(sessionId, { view: "window", line: requestedLine }, {
      signal: controller.signal,
      priority: activeRef.current ? 1 : 0,
      isCurrent,
    });
    windowRequestRef.current = { controller, task, token };
    try {
      const value = await task.promise;
      if (!isCurrent() || value === STALE_SESSION_RESPONSE) return false;
      applyWindow(value, requestedLine, forceClear);
      return true;
    } catch (reason) {
      if (isCurrent() && reason?.name !== "AbortError") {
        setError(reason?.message || "会话读取失败");
        setLoading(false);
        setPageLoading(false);
      }
      return false;
    } finally {
      if (windowRequestRef.current?.token === token) windowRequestRef.current = null;
      if (notify) callbacksRef.current.onRequestSettled?.(refreshVersion, panelId, token);
    }
  }, [applyWindow, cancelSearch, panelId, refreshVersion, sessionId]);

  const recoverStaleRevision = useCallback(async () => {
    cancelPage();
    cancelSearch();
    setPageLoading(false);
    setError("会话文件已变化，请点击「刷新」加载新内容。当前已加载内容保持不变。");
    return false;
  }, [cancelPage, cancelSearch]);

  const loadLine = useCallback(async (line) => {
    const current = currentRolloutRef.current;
    if (!current) return false;
    const target = boundedLine(line, current.totalLines ?? 0);
    if (target === 0) {
      anchorLineRef.current = 1;
      setCurrentLine(0);
      setEntries(cacheRef.current.get(current.revision, 0) ?? []);
      setPageLoading(false);
      return true;
    }

    const start = pageStart(target, current.totalLines, current.pageSize);
    cancelPage();
    cancelSearch();
    const cached = cacheRef.current.get(current.revision, start);
    if (cached) {
      const nextRollout = { ...current, startLine: start, endLine: pageEnd(start, current.totalLines, current.pageSize) };
      currentRolloutRef.current = nextRollout;
      setRollout(nextRollout);
      setEntries(cached);
      setCurrentLine(target);
      anchorLineRef.current = target;
      setPageLoading(false);
      setError("");
      return true;
    }

    const generation = generationRef.current;
    const token = Symbol("page request");
    const controller = new AbortController();
    const isCurrent = () => generationRef.current === generation && pageRequestRef.current?.token === token;
    setPageLoading(true);
    setError("");
    const task = enqueueSessionView(sessionId, { view: "page", revision: current.revision, line: target }, {
      signal: controller.signal,
      priority: activeRef.current ? 1 : 0,
      isCurrent,
    });
    pageRequestRef.current = { controller, task, token };
    try {
      const value = await task.promise;
      if (!isCurrent() || value === STALE_SESSION_RESPONSE) return false;
      if (value?.rollout?.revision !== current.revision || !Array.isArray(value?.lines)) {
        throw new SessionViewError(409, "stale_revision", "轨迹版本已变化，请刷新当前窗口。");
      }
      const page = projectPage(cacheRef.current, sessionId, value.rollout, value.lines);
      const nextRollout = { ...currentRolloutRef.current, ...value.rollout };
      currentRolloutRef.current = nextRollout;
      setRollout(nextRollout);
      setEntries(page.entries);
      setCurrentLine(target);
      anchorLineRef.current = target;
      setPageLoading(false);
      setError("");
      return true;
    } catch (reason) {
      if (!isCurrent() || reason?.name === "AbortError") return false;
      if (isStaleRevision(reason)) {
        const recovered = await recoverStaleRevision(target, current.revision);
        return recovered;
      }
      setError(reason?.message || "记录页读取失败");
      setPageLoading(false);
      return false;
    } finally {
      if (pageRequestRef.current?.token === token) pageRequestRef.current = null;
    }
  }, [cancelPage, cancelSearch, recoverStaleRevision, sessionId]);

  const requestSearch = useCallback(async (query, afterLine, revision, generation, operation) => {
    const controller = new AbortController();
    const token = Symbol("search request");
    const isCurrent = () => generationRef.current === generation
      && searchOperationRef.current === operation
      && searchRequestRef.current?.token === token;
    const task = enqueueSessionView(sessionId, { view: "search", revision, q: query, afterLine }, {
      signal: controller.signal,
      priority: activeRef.current ? 1 : 0,
      isCurrent,
    });
    searchRequestRef.current = { controller, task, token };
    try {
      const value = await task.promise;
      if (!isCurrent() || value === STALE_SESSION_RESPONSE) return undefined;
      if (value?.revision !== revision) throw new SessionViewError(409, "stale_revision", "轨迹版本已变化，请刷新当前窗口。");
      return value.lineNumber ?? null;
    } finally {
      if (searchRequestRef.current?.token === token) searchRequestRef.current = null;
    }
  }, [sessionId]);

  const searchNext = useCallback(async (query, afterLine) => {
    const current = currentRolloutRef.current;
    if (!current) return null;
    if (typeof query !== "string" || query.length < 1 || query.length > 256) {
      setError("查找文本需为 1 到 256 个 UTF-16 代码单元。");
      return null;
    }
    cancelSearch();
    const generation = generationRef.current;
    const operation = searchOperationRef.current + 1;
    searchOperationRef.current = operation;
    const startAfter = Math.max(0, Math.min(current.totalLines, Number.isSafeInteger(afterLine) ? afterLine : 0));
    setSearchLoading(true);
    setError("");
    try {
      let lineNumber;
      try {
        lineNumber = await requestSearch(query, startAfter, current.revision, generation, operation);
        if (searchOperationRef.current !== operation) return undefined;
        if (lineNumber === null && startAfter > 0) {
          lineNumber = await requestSearch(query, 0, current.revision, generation, operation);
          if (searchOperationRef.current !== operation) return undefined;
        }
      } catch (reason) {
        if (!isStaleRevision(reason)) throw reason;
        await recoverStaleRevision();
        return undefined;
      }
      return lineNumber;
    } catch (reason) {
      if (searchOperationRef.current === operation && reason?.name !== "AbortError") {
        setError(reason?.message || "轨迹查找失败");
      }
      return reason?.name === "AbortError" || searchOperationRef.current !== operation ? undefined : null;
    } finally {
      if (searchOperationRef.current === operation) setSearchLoading(false);
    }
  }, [cancelSearch, recoverStaleRevision, requestSearch]);

  const loadHistoryPage = useCallback(async (page) => {
    if (!detail || page < 1) return;
    cancelRequest(historyRequestRef);
    const controller = new AbortController();
    const generation = generationRef.current;
    const request = historyGenerationRef.current + 1;
    historyGenerationRef.current = request;
    const token = Symbol("history request");
    const isCurrent = () => generationRef.current === generation
      && historyGenerationRef.current === request
      && historyRequestRef.current?.token === token;
    setHistoryLoading(true);
    const task = enqueueSessionView(sessionId, { view: "history", historyPage: page, supplementRevision: detail.supplementRevision }, {
      signal: controller.signal,
      priority: activeRef.current ? 1 : 0,
      isCurrent,
    });
    historyRequestRef.current = { controller, task, token };
    try {
      const value = await task.promise;
      if (!isCurrent() || value === STALE_SESSION_RESPONSE) return;
      setDetail((current) => isCurrent() && current ? { ...current, supplement: value.supplement } : current);
      setError("");
    } catch (reason) {
      if (isCurrent() && reason?.name !== "AbortError") {
        const message = isStaleRevision(reason)
          ? "SQLite 数据已变化，请点击「刷新」加载新内容。当前已加载内容保持不变。"
          : reason instanceof SessionViewError && Number.isSafeInteger(reason.status)
          ? `SQLite 历史读取失败（${reason.status}）`
          : reason?.message || "SQLite 历史读取失败";
        setError(message);
      }
    } finally {
      if (isCurrent()) {
        setHistoryLoading(false);
        historyRequestRef.current = null;
      }
    }
  }, [detail, sessionId]);

  const retry = useCallback(() => setRetryVersion((value) => value + 1), []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    cancelRequest(windowRequestRef);
    cancelPage();
    cancelSearch();
    cancelRequest(historyRequestRef);
    historyGenerationRef.current += 1;
    cacheRef.current.clear();

    setLoading(true);
    setPageLoading(true);
    setError("");
    setHistoryLoading(false);
    const anchor = Math.max(1, anchorLineRef.current);
    void runWindow(anchor, generation, { notify: true, forceClear: true });

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      cancelRequest(windowRequestRef);
      cancelPage();
      cancelSearch();
      cancelRequest(historyRequestRef);
      historyGenerationRef.current += 1;
      cacheRef.current.clear();
    };
  }, [cancelPage, cancelSearch, panelId, refreshVersion, retryVersion, runWindow, sessionId]);

  return {
    detail,
    rollout,
    entries,
    currentLine,
    loading,
    pageLoading,
    searchLoading,
    error,
    historyLoading,
    loadLine,
    searchNext,
    loadHistoryPage,
    recoverStaleRevision,
    retry,
  };
}
