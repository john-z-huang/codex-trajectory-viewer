import test from "node:test";
import assert from "node:assert/strict";
import { groupSessionsByProject, normalizeSessionAgents, sessionDisplayTitle, sessionKindLabel } from "../src/lib/projects.js";

const sessions = [
  { id: "active-new", cwd: "/work/alpha", title: "最近活动", timestamp: "2026-04-03T10:00:00Z", archived: false },
  { id: "archived-old", cwd: "/work/alpha", title: "旧会话", timestamp: "2026-04-01T10:00:00Z", archived: true },
  { id: "same-name", cwd: "/archive/alpha", title: "另一路径", timestamp: "2026-04-02T10:00:00Z", archived: true },
  { id: "unknown", cwd: "", title: "无目录会话", timestamp: "2026-04-04T10:00:00Z", archived: false },
];

test("按完整 cwd 分组、保留同名不同路径并将缺失 cwd 放入项目未知", () => {
  const groups = groupSessionsByProject(sessions);
  assert.deepEqual(groups.map(({ cwd, name }) => [cwd, name]), [
    ["", "项目未知"],
    ["/work/alpha", "alpha"],
    ["/archive/alpha", "alpha"],
  ]);
  assert.deepEqual(groups[1].sessions.map(({ id }) => id), ["active-new", "archived-old"]);
  assert.equal(groups[1].sessions[1].archived, true);
});

test("按项目最近会话时间排序，目录名搜索显示该项目全部会话", () => {
  const groups = groupSessionsByProject(sessions, "alpha");
  assert.deepEqual(groups.map(({ cwd }) => cwd), ["/work/alpha", "/archive/alpha"]);
  assert.deepEqual(groups[0].sessions.map(({ id }) => id), ["active-new", "archived-old"]);
});

test("项目路径搜索与会话字段搜索均可用，未知项目可搜索", () => {
  assert.deepEqual(groupSessionsByProject(sessions, "/archive").map(({ cwd }) => cwd), ["/archive/alpha"]);
  assert.deepEqual(groupSessionsByProject(sessions, "旧会话").flatMap(({ sessions: items }) => items.map(({ id }) => id)), ["archived-old"]);
  assert.deepEqual(groupSessionsByProject(sessions, "项目未知").flatMap(({ sessions: items }) => items.map(({ id }) => id)), ["unknown"]);
});

test("子代理会话继承父项目分组并可按子代理标记和父会话搜索", () => {
  const parent = { id: "parent-file", sessionId: "parent-thread", cwd: "/work/alpha", title: "Deploy service", timestamp: "2026-04-03T10:00:00Z" };
  const child = {
    id: "child-file", sessionId: "child-thread", cwd: "", projectCwd: "/work/alpha", title: "Inspect logs",
    timestamp: "2026-04-03T10:01:00Z",
    agent: { agentPath: "research/worker", role: "explorer", parentThreadId: "parent-thread", parentTitle: "Deploy service", parentSessionId: "parent-file" },
  };
  const grouped = groupSessionsByProject([parent, child]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].cwd, "/work/alpha");
  assert.deepEqual(grouped[0].sessions.map(({ id }) => id), ["child-file", "parent-file"]);
  assert.deepEqual(groupSessionsByProject([parent, child], "子代理").flatMap((group) => group.sessions.map(({ id }) => id)), ["child-file"]);
  assert.deepEqual(groupSessionsByProject([parent, child], "Deploy service").flatMap((group) => group.sessions.map(({ id }) => id)), ["child-file", "parent-file"]);
  assert.deepEqual(groupSessionsByProject([parent, child], "research/worker").flatMap((group) => group.sessions.map(({ id }) => id)), ["child-file"]);
});

test("从 SQLite 序列化 source 识别子代理并显示父会话身份", () => {
  const parent = { id: "parent-file", sessionId: "parent-thread", cwd: "/work/alpha", title: "Deploy service" };
  const child = {
    id: "child-file",
    sessionId: "child-thread",
    cwd: "/work/alpha",
    source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "parent-thread", agent_path: "/root/primary_output", agent_nickname: "Lorentz" } } }),
  };
  const [normalizedParent, normalizedChild] = normalizeSessionAgents([parent, child]);
  assert.equal(normalizedParent.agent, undefined);
  assert.deepEqual(normalizedChild.agent, {
    threadId: "child-thread",
    parentThreadId: "parent-thread",
    sourceParentThreadId: "parent-thread",
    conflict: false,
    agentPath: "/root/primary_output",
    nickname: "Lorentz",
    role: null,
    depth: null,
    parentSessionId: "parent-file",
    parentTitle: "Deploy service",
  });
  assert.equal(groupSessionsByProject([normalizedParent, normalizedChild])[0].sessions.find((session) => session.id === "child-file").agent.agentPath, "/root/primary_output");
  assert.deepEqual(groupSessionsByProject([normalizedParent, normalizedChild], "子代理").flatMap((group) => group.sessions.map((session) => session.id)), ["child-file"]);
});

test("Guardian JSON source 标记为 Guardian会话且不继承父项目目录", () => {
  const parent = { id: "parent-file", sessionId: "parent-thread", cwd: "/work/parent" };
  const guardian = {
    id: "guardian-file",
    sessionId: "guardian-thread",
    cwd: "",
    projectCwd: "/work/parent",
    parent_thread_id: "parent-thread",
    thread_source: "guardian_review",
    source: JSON.stringify({ subagent: { other: "guardian" } }),
    agent: { parentThreadId: "parent-thread", parentSessionId: "parent-file" },
  };
  const [normalizedParent, normalizedGuardian] = normalizeSessionAgents([parent, guardian]);

  assert.equal(normalizedGuardian.guardian, true);
  assert.equal(normalizedGuardian.agent, undefined);
  assert.equal(normalizedGuardian.projectCwd, "");
  assert.equal(sessionKindLabel(normalizedGuardian), "Guardian会话");
  assert.deepEqual(
    groupSessionsByProject([normalizedParent, normalizedGuardian], "Guardian会话").flatMap((group) => group.sessions.map(({ id }) => id)),
    ["guardian-file"],
  );
  assert.deepEqual(
    groupSessionsByProject([normalizedParent, normalizedGuardian]).map(({ cwd }) => cwd),
    ["", "/work/parent"],
  );
});

test("子代理标题优先使用去掉 /root/ 前缀的 agent_path，缺失时保留标题回退", () => {
  const directive = "Please investigate the parent task and report findings.";
  assert.equal(sessionDisplayTitle({
    title: "",
    preview: directive,
    agent_path: "/root/subagent_classification",
    agent: { agentPath: "/root/subagent_classification", nickname: "Franklin" },
  }), "subagent_classification");
  assert.equal(sessionDisplayTitle({
    title: "",
    preview: directive,
    agent: { agentPath: ["/root", "workers", "research"], nickname: "Franklin" },
  }), "workers/research");
  assert.equal(sessionDisplayTitle({
    title: "",
    preview: directive,
    agent: { agentPath: "/workspace/worker", nickname: "Franklin" },
  }), "/workspace/worker");
  assert.equal(sessionDisplayTitle({
    title: "Existing child title",
    preview: directive,
    agent: { nickname: "Franklin" },
  }), "Existing child title");
  assert.equal(sessionDisplayTitle({
    title: "",
    preview: "",
    agent: { nickname: "Franklin" },
  }), "未命名会话");
});
