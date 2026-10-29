import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { createEmptySessionTabs, sessionTabsReducer } from "../lib/session-tabs.js";
import { normalizeSessionAgents, sessionDisplayTitle } from "../lib/session-identity.js";
import { SessionSidebar } from "./SessionSidebar.jsx";
import { SessionWorkspace } from "./SessionWorkspace.jsx";

export function SessionViewer() {
  const [sessions, setSessions] = useState([]);
  const [tabState, dispatchTabs] = useReducer(sessionTabsReducer, undefined, createEmptySessionTabs);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [refreshBatch, setRefreshBatch] = useState({ id: 0, listSettled: true, pending: new Map() });
  const initialLoadStarted = useRef(false);
  const batchIdRef = useRef(0);
  const listControllerRef = useRef(null);
  const loading = !refreshBatch.listSettled || refreshBatch.pending.size > 0;

  function makeTabId() {
    return globalThis.crypto?.randomUUID?.()
      ?? `session-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function refresh(openFirst = false) {
    const id = batchIdRef.current + 1;
    batchIdRef.current = id;
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    const pending = new Map(tabState.tabs.map((tab) => [tab.id, Symbol("pending detail request")]));
    setRefreshBatch({ id, listSettled: false, pending });
    setRefreshVersion(id);
    setError("");

    try {
      const response = await fetch("/api/sessions", { cache: "no-store", signal: controller.signal });
      if (id !== batchIdRef.current) return;
      if (!response.ok) throw new Error(`会话列表读取失败（${response.status}）`);
      const items = normalizeSessionAgents(await response.json());
      if (id !== batchIdRef.current) return;
      setSessions(items);
      if (openFirst && items[0] && !tabState.tabs.length) {
        const tabId = makeTabId();
        setRefreshBatch((current) => {
          if (current.id !== id) return current;
          const nextPending = new Map(current.pending);
          nextPending.set(tabId, Symbol("pending detail request"));
          return { ...current, pending: nextPending };
        });
        dispatchTabs({ type: "open", id: tabId, sessionId: items[0].id });
      }
    } catch (reason) {
      if (id === batchIdRef.current && reason?.name !== "AbortError") setError(reason?.message || "会话列表读取失败");
    } finally {
      if (listControllerRef.current === controller) listControllerRef.current = null;
      setRefreshBatch((current) => current.id === id ? { ...current, listSettled: true } : current);
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

  const onPanelRequestSettled = useCallback((version, panelId, requestToken) => {
    setRefreshBatch((current) => {
      if (current.id !== version || current.pending.get(panelId) !== requestToken) return current;
      const pending = new Map(current.pending);
      pending.delete(panelId);
      return { ...current, pending };
    });
  }, []);

  const onPanelClosed = useCallback((panelId) => {
    setRefreshBatch((current) => {
      if (!current.pending.has(panelId)) return current;
      const pending = new Map(current.pending);
      pending.delete(panelId);
      return { ...current, pending };
    });
  }, []);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    refresh(true);
  }, []);

  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeTabId);
  const activeSession = sessions.find((session) => session.id === activeTab?.sessionId);

  function openSession(sessionId) {
    dispatchTabs({ type: "open", id: makeTabId(), sessionId });
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
