import { isJsonRecord, type AgentMetadata, type Session, type SubagentActivity, type SubagentLink } from "./types.js";

function asText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.length && value.every((part) => typeof part === "string")) return value.join("/");
  return null;
}

export function isGuardianSession(metadata: unknown): boolean {
  const record = isJsonRecord(metadata) ? metadata : {};
  const source = isJsonRecord(record.source) ? record.source : {};
  const subagent = isJsonRecord(source.subagent) ? source.subagent : {};
  const subAgent = isJsonRecord(source.sub_agent) ? source.sub_agent : {};
  return record.thread_source === "guardian_review"
    || subagent.other === "guardian"
    || subAgent.other === "guardian";
}

export function subagentMetadataFromSession(metadata: unknown): AgentMetadata | null {
  const record = isJsonRecord(metadata) ? metadata : {};
  const source = isJsonRecord(record.source) ? record.source : null;
  const subAgent = source && isJsonRecord(source.sub_agent) ? source.sub_agent : null;
  const subagent = source && isJsonRecord(source.subagent) ? source.subagent : null;
  const spawnValue = subAgent?.thread_spawn ?? subagent?.thread_spawn;
  const spawn = isJsonRecord(spawnValue) ? spawnValue : null;
  const hasSpawn = spawn !== null;
  const hasTypedSubagentSource = source !== null
    && (Object.hasOwn(source, "sub_agent") || Object.hasOwn(source, "subagent"));
  if (isGuardianSession(metadata) || (hasTypedSubagentSource && !hasSpawn)) return null;

  const directParentValue = typeof record.parent_thread_id === "string" ? record.parent_thread_id : "";
  const directParentThreadId = directParentValue || null;
  const hasLegacyIdentity = Boolean(
    asText(record.agent_path)
    || asText(record.agent_nickname)
    || asText(record.agent_role),
  );
  const isLegacyAgent = Boolean(typeof record.source === "string" && record.source.trim().length > 0
    && directParentThreadId && hasLegacyIdentity);
  if (!hasSpawn && !isLegacyAgent) return null;

  const sourceParentValue = spawn && typeof spawn.parent_thread_id === "string" ? spawn.parent_thread_id : "";
  const sourceParentThreadId = sourceParentValue || null;
  const parentThreadId = sourceParentThreadId
    ?? directParentThreadId;
  const threadId = typeof record.id === "string" && record.id ? record.id : null;

  return {
    threadId,
    parentThreadId,
    sourceParentThreadId,
    conflict: Boolean(sourceParentThreadId && directParentThreadId && directParentThreadId !== sourceParentThreadId),
    agentPath: asText(record.agent_path) ?? (spawn ? asText(spawn.agent_path) : null),
    nickname: asText(record.agent_nickname) ?? (spawn ? asText(spawn.agent_nickname) : null),
    role: asText(record.agent_role) ?? (spawn ? asText(spawn.agent_role) : null),
    depth: spawn && typeof spawn.depth === "number" && Number.isSafeInteger(spawn.depth) ? spawn.depth : null,
  };
}

export function subagentActivityFromRollout(contents: string): SubagentActivity[] {
  const activities = new Map<string, SubagentActivity>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isJsonRecord(parsed) || parsed.type !== "event_msg") continue;

    const payload = isJsonRecord(parsed.payload) ? parsed.payload : {};
    const detailValue = payload.type === "sub_agent_activity"
      ? payload
      : payload.sub_agent_activity ?? payload.subagent_activity;
    if (!isJsonRecord(detailValue)) continue;
    const threadId = typeof detailValue.agent_thread_id === "string" ? detailValue.agent_thread_id : "";
    if (!threadId) continue;
    const detail = detailValue;

    const previous = activities.get(threadId);
    activities.set(threadId, {
      threadId,
      agentPath: asText(detail.agent_path) ?? previous?.agentPath ?? null,
      status: typeof detail.kind === "string" ? detail.kind : previous?.status ?? null,
    });
  }
  return [...activities.values()];
}

export function linkSubagents(parent: Session, sessions: Session[], activities: SubagentActivity[]): SubagentLink[] {
  const related = new Map<string, SubagentLink>();
  const candidatesByThreadId = new Map<string, Session>();
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
      agent: candidate?._agent ?? {
        threadId: activity.threadId,
        parentThreadId: parent.sessionId,
        sourceParentThreadId: null,
        conflict: false,
        agentPath: activity.agentPath,
        nickname: null,
        role: null,
        depth: null,
      },
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
