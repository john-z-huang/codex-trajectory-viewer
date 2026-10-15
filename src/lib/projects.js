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
  const searchable = [
    session.title,
    session.preview,
    session.cwd,
    session.model,
    session.source,
    session.sessionId,
    session.filename,
    session.archived ? "已归档" : "活动",
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  return searchable.includes(query);
}

export function groupSessionsByProject(sessions, search = "") {
  const groups = new Map();
  for (const session of sessions) {
    const cwd = typeof session.cwd === "string" ? session.cwd.trim() : "";
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
