import test from "node:test";
import assert from "node:assert/strict";
import { groupSessionsByProject } from "../src/lib/projects.js";

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
