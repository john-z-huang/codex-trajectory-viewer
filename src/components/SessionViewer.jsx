import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createEmptySessionTabs, sessionTabsReducer } from "../lib/session-tabs.js";
import { groupSessionsByProject } from "../lib/projects.js";
import { normalizeSessionAgents, sessionDisplayTitle } from "../lib/session-identity.js";
import { SessionSidebar } from "./SessionSidebar.jsx";
import { SessionWorkspace } from "./SessionWorkspace.jsx";

export function SessionViewer() {
  const [sessions, setSessions] = useState([]);
  const [tabState, dispatchTabs] = useReducer(sessionTabsReducer, undefined, createEmptySessionTabs);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const initialLoadStarted = useRef(false);

  function makeTabId() {
    return globalThis.crypto?.randomUUID?.()
      ?? `session-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function refresh(openFirst = false) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      if (!response.ok) throw new Error(`会话列表读取失败（${response.status}）`);
      const items = normalizeSessionAgents(await response.json());
      setSessions(items);
      setRefreshVersion((version) => version + 1);
      if (openFirst && items[0]) {
        dispatchTabs({ type: "open", id: makeTabId(), sessionId: items[0].id });
      }
    } catch (reason) {
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    refresh(true);
  }, []);

  const projectGroups = useMemo(() => groupSessionsByProject(sessions, search), [sessions, search]);
  const activeTab = tabState.tabs.find((tab) => tab.id === tabState.activeTabId);
  const activeSession = sessions.find((session) => session.id === activeTab?.sessionId);

  function openSession(sessionId) {
    dispatchTabs({ type: "open", id: makeTabId(), sessionId });
  }

  return (
    <main className="app-shell">
      <SessionSidebar
        projectGroups={projectGroups}
        search={search}
        onSearchChange={setSearch}
        activeSessionId={activeTab?.sessionId}
        onOpenSession={openSession}
        onRefresh={() => refresh()}
      />
      <SessionWorkspace
        sessions={sessions}
        tabState={tabState}
        dispatchTabs={dispatchTabs}
        activeSession={activeSession}
        refreshVersion={refreshVersion}
        loading={loading}
        error={error}
        onRefresh={() => refresh()}
        onOpenSession={openSession}
      />
    </main>
  );
}
