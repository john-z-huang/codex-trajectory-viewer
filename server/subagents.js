function asText(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.length && value.every((part) => typeof part === "string")) return value.join("/");
  return null;
}

export function isGuardianSession(metadata) {
  const source = metadata?.source;
  return metadata?.thread_source === "guardian_review"
    || source?.subagent?.other === "guardian"
    || source?.sub_agent?.other === "guardian";
}

export function subagentMetadataFromSession(metadata) {
  const source = metadata?.source;
  const spawn = source?.sub_agent?.thread_spawn ?? source?.subagent?.thread_spawn;
  const hasSpawn = Boolean(spawn && typeof spawn === "object");
  const hasTypedSubagentSource = source && typeof source === "object"
    && (Object.hasOwn(source, "sub_agent") || Object.hasOwn(source, "subagent"));
  if (isGuardianSession(metadata) || (hasTypedSubagentSource && !hasSpawn)) return null;

  const directParentThreadId = typeof metadata?.parent_thread_id === "string" && metadata.parent_thread_id
    ? metadata.parent_thread_id
    : null;
  const hasLegacyIdentity = Boolean(
    asText(metadata?.agent_path)
    || asText(metadata?.agent_nickname)
    || asText(metadata?.agent_role),
  );
  const isLegacyAgent = typeof source === "string" && source.trim().length > 0
    && directParentThreadId && hasLegacyIdentity;
  if (!hasSpawn && !isLegacyAgent) return null;

  const sourceParentThreadId = hasSpawn && typeof spawn.parent_thread_id === "string" && spawn.parent_thread_id
    ? spawn.parent_thread_id
    : null;
  const parentThreadId = sourceParentThreadId
    ?? directParentThreadId;
  const threadId = typeof metadata.id === "string" && metadata.id ? metadata.id : null;

  return {
    threadId,
    parentThreadId,
    sourceParentThreadId,
    conflict: Boolean(sourceParentThreadId && directParentThreadId && directParentThreadId !== sourceParentThreadId),
    agentPath: asText(metadata.agent_path) ?? (hasSpawn ? asText(spawn.agent_path) : null),
    nickname: asText(metadata.agent_nickname) ?? (hasSpawn ? asText(spawn.agent_nickname) : null),
    role: asText(metadata.agent_role) ?? (hasSpawn ? asText(spawn.agent_role) : null),
    depth: hasSpawn && Number.isSafeInteger(spawn.depth) ? spawn.depth : null,
  };
}

export function subagentActivityFromRollout(contents) {
  const activities = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== "event_msg") continue;

    const payload = record.payload;
    const detail = payload?.type === "sub_agent_activity"
      ? payload
      : payload?.sub_agent_activity ?? payload?.subagent_activity;
    if (!detail || typeof detail.agent_thread_id !== "string" || !detail.agent_thread_id) continue;

    const threadId = detail.agent_thread_id;
    const previous = activities.get(threadId);
    activities.set(threadId, {
      threadId,
      agentPath: asText(detail.agent_path) ?? previous?.agentPath ?? null,
      status: typeof detail.kind === "string" ? detail.kind : previous?.status ?? null,
    });
  }
  return [...activities.values()];
}

export function linkSubagents(parent, sessions, activities) {
  const related = new Map();
  const candidatesByThreadId = new Map();
  for (const session of sessions) {
    if (typeof session.sessionId !== "string" || !session.sessionId || session.sessionId === parent.sessionId) continue;
    const existing = candidatesByThreadId.get(session.sessionId);
    if (!existing || session.timestamp > existing.timestamp) candidatesByThreadId.set(session.sessionId, session);
  }

  for (const session of candidatesByThreadId.values()) {
    const agent = session._agent;
    if (agent?.parentThreadId !== parent.sessionId) continue;
    if (agent.conflict || !agent.threadId || agent.threadId !== session.sessionId) {
      related.set(session.sessionId, {
        threadId: session.sessionId,
        session: null,
        agent: { ...agent, threadId: session.sessionId },
        status: "metadata_conflict",
        reason: "子代理元数据中的父子标识不一致，已停止自动关联。",
      });
      continue;
    }
    related.set(session.sessionId, {
      threadId: session.sessionId,
      session,
      agent,
      status: null,
      reason: null,
    });
  }

  for (const activity of activities) {
    const existing = related.get(activity.threadId);
    const candidate = candidatesByThreadId.get(activity.threadId);
    if (existing?.status === "metadata_conflict") {
      existing.status = activity.status ?? existing.status;
      continue;
    }
    if (candidate && candidate._agent?.parentThreadId && candidate._agent.parentThreadId !== parent.sessionId) {
      related.set(activity.threadId, {
        threadId: activity.threadId,
        session: null,
        agent: { ...candidate._agent, threadId: activity.threadId, agentPath: candidate._agent.agentPath ?? activity.agentPath },
        status: "metadata_conflict",
        reason: "父会话事件与子会话元数据指向不同父线程，已停止自动关联。",
      });
      continue;
    }
    related.set(activity.threadId, {
      threadId: activity.threadId,
      session: candidate ?? null,
      agent: candidate?._agent ?? { threadId: activity.threadId, parentThreadId: parent.sessionId, agentPath: activity.agentPath },
      status: activity.status,
      reason: candidate ? null : "父会话记录了该子代理，但没有发现可读取的子会话 rollout。",
    });
  }

  return [...related.values()].sort((a, b) => {
    const left = a.agent?.agentPath ?? a.session?.timestamp ?? a.threadId;
    const right = b.agent?.agentPath ?? b.session?.timestamp ?? b.threadId;
    return String(left).localeCompare(String(right));
  });
}
