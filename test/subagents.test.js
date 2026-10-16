import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSessionAgents } from "../src/lib/session-identity.js";
import { linkSubagents, subagentActivityFromRollout, subagentMetadataFromSession } from "../server/subagents.js";

test("子代理元数据支持 thread_spawn 与顶层 parent_thread_id 两种 Codex 记录", () => {
  const metadata = subagentMetadataFromSession({
    id: "child-1",
    parent_thread_id: "parent-1",
    source: { sub_agent: { thread_spawn: { parent_thread_id: "parent-1", depth: 1, agent_path: ["research"] } } },
    agent_nickname: "Bluebird",
    agent_role: "explorer",
  });
  assert.deepEqual(metadata, {
    threadId: "child-1",
    parentThreadId: "parent-1",
    sourceParentThreadId: "parent-1",
    conflict: false,
    agentPath: "research",
    nickname: "Bluebird",
    role: "explorer",
    depth: 1,
  });
  assert.deepEqual(subagentMetadataFromSession({
    id: "flat-child",
    parent_thread_id: "parent-1",
    source: "vscode",
    agent_path: ["writer"],
  }), {
    threadId: "flat-child",
    parentThreadId: "parent-1",
    sourceParentThreadId: null,
    conflict: false,
    agentPath: "writer",
    nickname: null,
    role: null,
    depth: null,
  });
  assert.equal(subagentMetadataFromSession({
    id: "guardian",
    parent_thread_id: "parent-1",
    source: { subagent: { other: "guardian" } },
    thread_source: "guardian_review",
  }), null);
  assert.equal(subagentMetadataFromSession({
    id: "review",
    parent_thread_id: "parent-1",
    source: { subagent: { review: {} } },
    agent_path: ["reviewer"],
  }), null);
  assert.equal(subagentMetadataFromSession({ id: "unrelated", source: { sub_agent: "review" } }), null);
});

test("冲突的顶层与 source 父 ID 被标记而不自动确认", () => {
  const metadata = subagentMetadataFromSession({
    id: "child-1",
    parent_thread_id: "parent-a",
    source: { sub_agent: { thread_spawn: { parent_thread_id: "parent-b" } } },
  });
  assert.ok(metadata);
  assert.equal(metadata.parentThreadId, "parent-b");
  assert.equal(metadata.conflict, true);
});

test("Guardian review 保持普通会话且不继承父项目路径", () => {
  const guardian = {
    id: "guardian-session",
    sessionId: "guardian-thread",
    thread_source: "guardian_review",
    parent_thread_id: "parent-thread",
    source: { subagent: { other: "guardian" } },
  };
  const parent = {
    id: "parent-session",
    sessionId: "parent-thread",
    cwd: "/work/project",
  };

  const [normalizedGuardian] = normalizeSessionAgents([guardian, parent]);

  assert.equal(normalizedGuardian.agent, undefined);
  assert.equal(normalizedGuardian.projectCwd, "");
});

test("非 spawn 的 typed subagent 变体不因顶层父 ID 或 agent_path 被标记", () => {
  const typedReview = {
    id: "review-session",
    sessionId: "review-thread",
    parent_thread_id: "parent-thread",
    source: { subagent: { review: {} } },
    agent_path: ["reviewer"],
  };
  const parent = {
    id: "parent-session",
    sessionId: "parent-thread",
    cwd: "/work/project",
  };

  const [normalizedReview] = normalizeSessionAgents([typedReview, parent]);

  assert.equal(normalizedReview.agent, undefined);
  assert.equal(normalizedReview.projectCwd, "");
});

test("thread_spawn 与父 ID 冲突仍识别代理并阻止自动关联", () => {
  const spawnChild = {
    id: "spawn-child",
    sessionId: "spawn-child-thread",
    parent_thread_id: "different-parent",
    source: { subagent: { thread_spawn: { parent_thread_id: "parent-thread", agent_path: ["worker"] } } },
  };
  const parent = {
    id: "parent-session",
    sessionId: "parent-thread",
    cwd: "/work/project",
  };

  const [normalizedChild] = normalizeSessionAgents([spawnChild, parent]);

  assert.equal(normalizedChild.agent.parentThreadId, "parent-thread");
  assert.equal(normalizedChild.agent.conflict, true);
  assert.equal(normalizedChild.agent.parentSessionId, null);
  assert.equal(normalizedChild.projectCwd, "");
});

test("旧格式子代理保留普通字符串 source、顶层父 ID 与 agent_path", () => {
  const legacyChild = {
    id: "legacy-child",
    sessionId: "legacy-child-thread",
    source: "vscode",
    parent_thread_id: "parent-thread",
    agent_path: ["writer"],
  };
  const parent = {
    id: "parent-session",
    sessionId: "parent-thread",
    cwd: "/work/project",
  };

  const [normalizedChild] = normalizeSessionAgents([legacyChild, parent]);

  assert.equal(normalizedChild.agent.parentThreadId, "parent-thread");
  assert.equal(normalizedChild.agent.agentPath, "writer");
  assert.equal(normalizedChild.projectCwd, "/work/project");
});

test("从 Codex sub_agent_activity 事件读取 thread id、路径与最新状态", () => {
  const contents = [
    JSON.stringify({ type: "event_msg", payload: { type: "sub_agent_activity", agent_thread_id: "child-1", agent_path: ["review"], kind: "started" } }),
    JSON.stringify({ type: "event_msg", payload: { sub_agent_activity: { agent_thread_id: "child-1", kind: "completed" } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", agent_thread_id: "not-a-child" } }),
    "damaged line",
  ].join("\n");
  assert.deepEqual(subagentActivityFromRollout(contents), [{ threadId: "child-1", agentPath: "review", status: "completed" }]);
});

test("通过父子元数据和父事件 ID 合并子代理，并呈现缺失或冲突状态", () => {
  const parent = { sessionId: "parent-1" };
  assert.deepEqual(linkSubagents(parent, [parent], []), []);
  const child = {
    id: "sessions/2026/10/15/child.jsonl",
    sessionId: "child-1",
    timestamp: "2026-10-15T00:00:00.000Z",
    _agent: { threadId: "child-1", parentThreadId: "parent-1", sourceParentThreadId: "parent-1", conflict: false, agentPath: "worker" },
  };
  const mismatch = {
    id: "sessions/2026/10/15/mismatch.jsonl",
    sessionId: "child-2",
    timestamp: "2026-10-15T00:01:00.000Z",
    _agent: { threadId: "child-2", parentThreadId: "parent-1", sourceParentThreadId: "parent-1", conflict: true, agentPath: "conflicted" },
  };
  const unrelated = {
    id: "sessions/2026/10/15/unrelated.jsonl",
    sessionId: "child-3",
    timestamp: "2026-10-15T00:02:00.000Z",
    _agent: { threadId: "child-3", parentThreadId: "different-parent", sourceParentThreadId: "different-parent", conflict: false },
  };

  const linked = linkSubagents(parent, [parent, child, mismatch, unrelated], [
    { threadId: "child-1", agentPath: "worker", status: "completed" },
    { threadId: "missing-child", agentPath: "missing", status: "started" },
    { threadId: "child-2", agentPath: "conflicted", status: "started" },
  ]);

  assert.equal(linked.length, 3);
  assert.equal(linked.find((item) => item.threadId === "child-1").session, child);
  assert.equal(linked.find((item) => item.threadId === "missing-child").session, null);
  assert.match(linked.find((item) => item.threadId === "missing-child").reason, /没有发现可读取/);
  assert.equal(linked.find((item) => item.threadId === "child-2").session, null);
  assert.match(linked.find((item) => item.threadId === "child-2").reason, /标识不一致/);
});
