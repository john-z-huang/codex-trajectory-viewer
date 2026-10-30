import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createEmptySessionTabs, sessionTabsReducer } from "../lib/session-tabs.js";
import { normalizeSessionAgents, sessionDisplayTitle } from "../lib/session-identity.js";
import { browserLogger, createLogId } from "../lib/logger.js";
import { serverDuration } from "../lib/session-view-requests.js";
import { SessionSidebar } from "./SessionSidebar.jsx";
import { SessionWorkspace } from "./SessionWorkspace.jsx";

export function SessionViewer() {
  const [sessions, setSessions] = useState([]);
  const [tabState, dispatchTabs] = useReducer(sessionTabsReducer, undefined, createEmptySessionTabs);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshBatch, setRefreshBatch] = useState({ id: 0, operationId: null, listSettled: true, pending: new Map(), detailOutcomes: [] });
  const initialLoadStarted = useRef(false);
  const batchIdRef = useRef(0);
  const listControllerRef = useRef(null);
  const tabOperationIdsRef = useRef(new Map());
  const completedRefreshIdRef = useRef(null);
  const loading = !refreshBatch.listSettled || refreshBatch.pending.size > 0;

  useLayoutEffect(() => {
    const mounted = new Set(tabState.tabs.map((tab) => tab.id));
    for (const id of tabOperationIdsRef.current.keys()) {
      if (!mounted.has(id)) tabOperationIdsRef.current.delete(id);
    }
  }, [tabState.tabs]);

  function makeTabId() {
    return createLogId();
  }

  function now() {
    return globalThis.performance?.now?.() ?? Date.now();
  }

  async function refresh(openFirst = false) {
    const previous = refreshBatch;
    if (previous.operationId && completedRefreshIdRef.current !== previous.operationId) {
      completedRefreshIdRef.current = previous.operationId;
      browserLogger.log("browser_refresh", {
        action: "cancel",
        outcome: "cancelled",
        duration_ms: Math.max(0, Math.round(now() - previous.startedAt)),
        result_count: previous.resultCount,
        operation_id: previous.operationId,
      }, { operation_id: previous.operationId });
    }
    const id = batchIdRef.current + 1;
    batchIdRef.current = id;
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    const operationId = createLogId();
    const startedAt = now();
    for (const tab of tabState.tabs) tabOperationIdsRef.current.set(tab.id, operationId);
    const pending = new Map(tabState.tabs.map((tab) => [tab.id, Symbol("pending detail request")]));
    setRefreshBatch({ id, operationId, startedAt, listSettled: false, listOutcome: null, resultCount: 0, detailOutcomes: [], pending });
    setRefreshVersion(id);
    setError("");
    browserLogger.log("browser_refresh", { action: "start", outcome: "queued", operation_id: operationId }, { operation_id: operationId });

    const requestStartedAt = now();
    let responseStatus;
    let responseRequestId;
    let responseServerMs;
    let listOutcome = "failure";
    let resultCount = 0;
    try {
      const response = await fetch("/api/sessions", {
        cache: "no-store",
        signal: controller.signal,
        headers: { "X-Operation-Id": operationId },
      });
      responseStatus = response.status;
      responseRequestId = response.headers?.get?.("x-request-id") ?? undefined;
      responseServerMs = serverDuration(response);
      if (id !== batchIdRef.current) { listOutcome = controller.signal.aborted ? "aborted" : "stale"; return; }
      if (!response.ok) throw new Error(`会话列表读取失败（${response.status}）`);
      const items = normalizeSessionAgents(await response.json());
      if (id !== batchIdRef.current) { listOutcome = controller.signal.aborted ? "aborted" : "stale"; return; }
      listOutcome = "success";
      resultCount = items.length;
      setSessions(items);
      if (openFirst && items[0] && !tabState.tabs.length) {
        const tabId = makeTabId();
        tabOperationIdsRef.current.set(tabId, operationId);
        browserLogger.log("browser_tab", { action: "open", tab_id: tabId, operation_id: operationId }, { operation_id: operationId, tab_id: tabId });
        setRefreshBatch((current) => {
          if (current.id !== id) return current;
          const nextPending = new Map(current.pending);
          nextPending.set(tabId, Symbol("pending detail request"));
          return { ...current, pending: nextPending };
        });
        dispatchTabs({ type: "open", id: tabId, sessionId: items[0].id });
      }
    } catch (reason) {
      listOutcome = reason?.name === "AbortError" ? "aborted" : "failure";
      if (id === batchIdRef.current && reason?.name !== "AbortError") setError(reason?.message || "会话列表读取失败");
    } finally {
      const networkMs = Math.max(0, Math.round(now() - requestStartedAt));
      browserLogger.log("browser_list_request", {
        status: responseStatus,
        duration_ms: networkMs,
        queue_ms: 0,
        network_ms: networkMs,
        server_ms: responseServerMs,
        outcome: listOutcome === "success" ? "success" : listOutcome === "aborted" ? "aborted" : listOutcome === "stale" ? "stale" : "failure",
        error_code: listOutcome === "success" ? undefined : listOutcome === "aborted" ? "aborted" : listOutcome === "failure" ? "internal_error" : undefined,
        result_count: listOutcome === "success" ? resultCount : undefined,
        operation_id: operationId,
      }, { operation_id: operationId, request_id: responseRequestId });
      if (listControllerRef.current === controller) listControllerRef.current = null;
      setRefreshBatch((current) => current.id === id ? { ...current, listSettled: true, listOutcome, resultCount } : current);
    }
  }

  const onPanelRequestStart = useCallback((version, panelId, requestToken) => {
    setRefreshBatch((current) => {
      if (current.id !== version || current.pending.get(panelId) === requestToken) return current;
      if (current.listSettled && current.pending.size === 0 && !current.pending.has(panelId)) return current;
      const pending = new Map(current.pending);
      pending.set(panelId, requestToken);
      return { ...current, pending };
    });
  }, []);

  const onPanelRequestSettled = useCallback((version, panelId, requestToken, outcome = "success") => {
    setRefreshBatch((current) => {
      if (current.id !== version || current.pending.get(panelId) !== requestToken) return current;
      const pending = new Map(current.pending);
      pending.delete(panelId);
      return { ...current, pending, detailOutcomes: [...current.detailOutcomes, outcome] };
    });
  }, []);

  const onPanelClosed = useCallback((panelId) => {
    tabOperationIdsRef.current.delete(panelId);
    setRefreshBatch((current) => {
      if (!current.pending.has(panelId)) return current;
      const pending = new Map(current.pending);
      pending.delete(panelId);
      return { ...current, pending, detailOutcomes: [...current.detailOutcomes, "cancelled"] };
    });
  }, []);

  useEffect(() => {
    if (!refreshBatch.operationId || !refreshBatch.listSettled || refreshBatch.pending.size > 0) return;
    if (completedRefreshIdRef.current === refreshBatch.operationId) return;
    completedRefreshIdRef.current = refreshBatch.operationId;
    const detailOutcomes = refreshBatch.detailOutcomes ?? [];
    const outcome = refreshBatch.listOutcome !== "success"
      ? refreshBatch.listOutcome === "aborted" ? "cancelled" : "failure"
      : detailOutcomes.includes("failure") ? "failure"
        : detailOutcomes.includes("degraded") ? "degraded"
          : detailOutcomes.includes("stale") ? "stale"
            : "success";
    browserLogger.log("browser_refresh", {
      action: outcome === "failure" ? "failure" : "success",
      outcome,
      duration_ms: Math.max(0, Math.round(now() - refreshBatch.startedAt)),
      result_count: refreshBatch.resultCount,
      operation_id: refreshBatch.operationId,
    }, { operation_id: refreshBatch.operationId });
  }, [refreshBatch]);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    refresh(true);
  }, []);

  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeTabId);
  const activeSession = sessions.find((session) => session.id === activeTab?.sessionId);

  function openSession(sessionId) {
    const existing = tabState.tabs.find((tab) => tab.sessionId === sessionId && tabOperationIdsRef.current.has(tab.id));
    const tabId = existing?.id ?? makeTabId();
    const operationId = createLogId();
    if (!existing) tabOperationIdsRef.current.set(tabId, operationId);
    browserLogger.log("browser_tab", {
      action: existing ? "reactivate" : "open",
      tab_id: tabId,
      operation_id: operationId,
    }, { operation_id: operationId, tab_id: tabId });
    dispatchTabs({ type: "open", id: tabId, sessionId });
  }

  return (
    <main className="app-shell">
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeTab?.sessionId}
        onOpenSession={openSession}
        onRefresh={() => refresh()}
        loading={loading}
      />
      <SessionWorkspace
        sessions={sessions}
        tabState={tabState}
        dispatchTabs={dispatchTabs}
        activeSession={activeSession}
        activeTabId={activeTab?.id}
        refreshVersion={refreshVersion}
        operationIdForTab={(tabId) => tabOperationIdsRef.current.get(tabId)}
        loading={loading}
        error={error}
        onRefresh={() => refresh()}
        onOpenSession={openSession}
        onRequestStart={onPanelRequestStart}
        onRequestSettled={onPanelRequestSettled}
        onPanelClosed={onPanelClosed}
      />
    </main>
  );
}
