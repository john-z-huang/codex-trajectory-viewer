import assert from "node:assert/strict";
import test from "node:test";
import { JSONL_RECORD_TYPES, filterLeaves, recordFilterType } from "../src/lib/conversation-types.js";
import { parseRolloutText, projectRolloutLines } from "../src/lib/rollout.js";
import { SQLITE_ITEM_TYPES, projectSqliteRow, sqliteItemType } from "../src/lib/sqlite-history.js";

test("JSONL 筛选沿用实际投影类型，未知事件、坏行和受限预览默认有对应选项", () => {
  const records = [
    { type: "event_msg", payload: { user_message: { message: "synthetic user" } } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
    { type: "response_item", payload: { type: "function_call", name: "synthetic_tool" } },
    { type: "event_msg", payload: { type: "mcp_tool_call_end", result: {} } },
    { type: "response_item", payload: { type: "reasoning", summary: [] } },
    { type: "session_meta", payload: {} },
    { type: "future_event", payload: {} },
  ];
  const lines = records.map((record, index) => ({ lineNumber: index + 1, raw: JSON.stringify(record) }));
  lines.push({ lineNumber: 8, raw: "{broken" }, { lineNumber: 9, raw: "" }, { lineNumber: 10, oversized: true });
  const entries = projectRolloutLines(lines, { revision: "synthetic-revision" });
  assert.deepEqual(entries.map((entry) => recordFilterType(entry.filterType ?? entry.kind, JSONL_RECORD_TYPES)), [
    "user/event", "assistant/message", "tool-call/function", "tool-result/mcp", "event/reasoning", "metadata/session-meta", "event/other", "invalid", "empty", "oversized",
  ]);
  assert.equal(recordFilterType("future_kind", JSONL_RECORD_TYPES), "other");
  assert.equal(recordFilterType("__proto__", JSONL_RECORD_TYPES), "other");
});

test("SQLite 筛选与卡片投影遵循同一 payload 优先规则且不会改写原行", () => {
  for (const { value, label } of filterLeaves(SQLITE_ITEM_TYPES).filter(({ value }) => value !== "other")) {
    const row = { item_type: "conflicting-type", item_json: JSON.stringify({ type: value }) };
    const before = JSON.stringify(row);
    assert.equal(sqliteItemType(row), value);
    assert.equal(projectSqliteRow("thread_items", row).title, label);
    assert.equal(recordFilterType(sqliteItemType(row), SQLITE_ITEM_TYPES), value);
    assert.equal(JSON.stringify(row), before);
  }
  for (const item_json of ["{broken", "null", "[]", "", undefined]) {
    const row = { item_type: "userMessage", item_json };
    assert.equal(sqliteItemType(row), "userMessage");
    assert.equal(projectSqliteRow("thread_items", row).title, "用户消息");
  }
  assert.equal(sqliteItemType({ item_json: { type: "agentMessage" } }), "agentMessage");
  for (const row of [{}, { item_json: '{"type":"future_item"}' }, { item_type: "__proto__" }]) {
    assert.equal(recordFilterType(sqliteItemType(row), SQLITE_ITEM_TYPES), "other");
  }
});

test("JSONL 事件子类型兼容顶层、discriminator、keyed 及消息项目封装", () => {
  const cases = [
    ["token_usage_record", "event/token-usage"], ["token_count", "event/token-usage"],
    ["reasoning", "event/reasoning"], ["agent_reasoning", "event/reasoning"],
    ["task_started", "event/turn-start"], ["turn_started", "event/turn-start"],
    ["item_completed", "event/item-completed"], ["turn_context", "event/turn-context"],
    ["compacted", "event/compacted"], ["retained_context", "event/retained-context"],
    ["world_state", "event/world-state"], ["thread_settings_applied", "event/thread-settings"],
    ["additional_tools", "event/additional-tools"], ["inter_agent_communication", "event/communication"],
    ["security_risk_score", "event/security"], ["realtime_item", "event/realtime"],
    ["future_event", "event/other"], ["__proto__", "event/other"],
  ];
  for (const [type, expected] of cases) {
    const records = [
      { type, payload: {} },
      { type: "event_msg", payload: { type } },
      { type: "event_msg", payload: { [type]: {} } },
      { type: "response_item", payload: { type } },
    ];
    for (const record of records) {
      const raw = JSON.stringify(record);
      const [entry] = projectRolloutLines([{ lineNumber: 31, raw }], { revision: "synthetic-revision", sessionId: "synthetic-id" });
      assert.equal(entry.kind, "event");
      assert.equal(entry.filterType, expected, raw);
      assert.equal(parseRolloutText(raw)[0].filterType, expected);
      assert.equal(entry.lineNumber, 31);
      assert.deepEqual(entry.originalLocator, { lineNumber: 31, revision: "synthetic-revision", sessionId: "synthetic-id" });
      assert.ok(new TextEncoder().encode(JSON.stringify(entry)).byteLength <= 64 * 1024);
      assert.equal(Object.hasOwn(entry, "raw"), false);
    }
  }
});

test("工具、消息及元数据子类型使用真实 discriminator，树的全部叶子唯一且无丢失兜底", () => {
  const cases = [
    [{ type: "response_item", payload: { type: "message", role: "user" } }, "user/message"],
    [{ type: "event_msg", payload: { agent_message: { message: "synthetic" } } }, "assistant/event"],
    [{ type: "response_item", payload: { type: "custom_tool_call", input: "synthetic" } }, "tool-call/custom"],
    [{ type: "event_msg", payload: { type: "exec_command_begin" } }, "tool-call/command"],
    [{ type: "event_msg", payload: { mcp_tool_call_begin: {} } }, "tool-call/mcp"],
    [{ type: "response_item", payload: { type: "function_call_output", output: "synthetic" } }, "tool-result/function"],
    [{ type: "response_item", payload: { type: "custom_tool_call_output", output: "synthetic" } }, "tool-result/custom"],
    [{ type: "event_msg", payload: { type: "exec_command_end" } }, "tool-result/command"],
    [{ type: "session_meta_entry", payload: {} }, "metadata/session-meta-entry"],
  ];
  for (const [record, expected] of cases) {
    assert.equal(projectRolloutLines([{ lineNumber: 1, raw: JSON.stringify(record) }])[0].filterType, expected);
  }
  for (const tree of [JSONL_RECORD_TYPES, SQLITE_ITEM_TYPES]) {
    const leaves = filterLeaves(tree);
    assert.equal(new Set(leaves.map(({ value }) => value)).size, leaves.length);
    for (const { value } of leaves) assert.equal(recordFilterType(value, tree), value);
  }
  assert.equal(recordFilterType("event", JSONL_RECORD_TYPES), "event/other", "legacy projections keep a visible fallback");
  assert.equal(recordFilterType("calls", SQLITE_ITEM_TYPES), "other", "unknown payload cannot collide with a UI-only group");
});
