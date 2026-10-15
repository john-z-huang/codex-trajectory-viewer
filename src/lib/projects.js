function timestampValue(session) {
  const value = new Date(session.updatedAt ?? session.timestamp ?? 0).valueOf();
  return Number.isFinite(value) ? value : 0;
}

function projectName(cwd) {
  if (!cwd) return "项目未知";
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).at(-1) || cwd;
}

function matchesSession(session, query) {
  const agent = session.agent;
  const searchable = [
    session.title,
    session.preview,
    session.cwd,
    session.projectCwd,
    session.model,
    session.source,
    session.sessionId,
    session.filename,
    session.archived ? "已归档" : "活动",
    sessionKindLabel(session),
    agent ? "子代理 子代理会话" : "",
    agent?.agentPath,
    agent?.nickname,
    agent?.role,
    agent?.parentTitle,
    agent?.parentThreadId,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  return searchable.includes(query);
}

function serializedSource(session) {
  const source = session.source;
  if (source && typeof source === "object") return source;
  if (typeof source !== "string") return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function agentPathText(value) {
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join("/") || null;
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeSessionAgents(sessions) {
  const withAgent = sessions.map((session) => {
    const source = serializedSource(session);
    const spawn = source?.sub_agent?.thread_spawn ?? source?.subagent?.thread_spawn;
    const hasTypedSubagentSource = source
      && (Object.hasOwn(source, "sub_agent") || Object.hasOwn(source, "subagent"));
    const isGuardian = Boolean(session.guardian)
      || session.thread_source === "guardian_review"
      || source?.subagent?.other === "guardian"
      || source?.sub_agent?.other === "guardian";
    if (isGuardian || (hasTypedSubagentSource && !spawn)) {
      return {
        ...session,
        agent: undefined,
        guardian: isGuardian || session.guardian,
        projectCwd: session.cwd || "",
      };
    }
    if (session.agent) return session;

    const sourceParentThreadId = typeof spawn?.parent_thread_id === "string" && spawn.parent_thread_id
      ? spawn.parent_thread_id
      : null;
    const directParentThreadId = typeof session.parent_thread_id === "string" && session.parent_thread_id
      ? session.parent_thread_id
      : null;
    const hasLegacyAgentIdentity = Boolean(
      agentPathText(session.agent_path)
      || (typeof session.agent_nickname === "string" && session.agent_nickname)
      || (typeof session.agent_role === "string" && session.agent_role),
    );
    const isLegacyAgent = typeof session.source === "string"
      && session.source.trim().length > 0
      && directParentThreadId
      && hasLegacyAgentIdentity;
    if (!sourceParentThreadId && !isLegacyAgent) return session;

    return {
      ...session,
      agent: {
        threadId: session.sessionId ?? null,
        parentThreadId: sourceParentThreadId ?? directParentThreadId,
        sourceParentThreadId,
        conflict: Boolean(sourceParentThreadId && directParentThreadId && sourceParentThreadId !== directParentThreadId),
        agentPath: agentPathText(session.agent_path) ?? agentPathText(spawn?.agent_path),
        nickname: session.agent_nickname ?? spawn?.agent_nickname ?? null,
        role: session.agent_role ?? spawn?.agent_role ?? null,
        depth: Number.isSafeInteger(spawn?.depth) ? spawn.depth : null,
      },
    };
  });
  const byThreadId = new Map(withAgent.map((session) => [String(session.sessionId), session]));
  return withAgent.map((session) => {
    const agent = session.agent;
    if (!agent?.parentThreadId) return session;
    const parent = agent.conflict ? null : byThreadId.get(String(agent.parentThreadId));
    return {
      ...session,
      projectCwd: session.projectCwd || session.cwd || parent?.cwd || "",
      agent: {
        ...agent,
        parentSessionId: agent.parentSessionId ?? parent?.id ?? null,
        parentTitle: agent.parentTitle || parent?.title || parent?.preview || null,
      },
    };
  });
}

export function sessionKindLabel(session) {
  if (session.guardian) return "Guardian会话";
  return session.agent ? "子代理会话" : "主会话";
}

export function groupSessionsByProject(sessions, search = "") {
  const groups = new Map();
  for (const session of sessions) {
    const cwd = typeof (session.projectCwd ?? session.cwd) === "string" ? (session.projectCwd ?? session.cwd).trim() : "";
    const key = cwd || "\u0000unknown-project";
    if (!groups.has(key)) groups.set(key, { key, cwd, name: projectName(cwd), sessions: [], latest: 0 });
    const group = groups.get(key);
    group.sessions.push(session);
    group.latest = Math.max(group.latest, timestampValue(session));
  }

  const query = search.trim().toLocaleLowerCase();
  return [...groups.values()]
    .map((group) => {
      const projectMatches = !query || `${group.name} ${group.cwd || "项目未知"}`.toLocaleLowerCase().includes(query);
      const sessionsInGroup = projectMatches ? group.sessions : group.sessions.filter((session) => matchesSession(session, query));
      return { ...group, sessions: sessionsInGroup.sort((a, b) => timestampValue(b) - timestampValue(a)) };
    })
    .filter((group) => group.sessions.length > 0)
    .sort((a, b) => b.latest - a.latest || a.name.localeCompare(b.name, "zh-CN"));
}
