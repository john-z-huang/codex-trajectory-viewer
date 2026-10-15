import test from "node:test";
import assert from "node:assert/strict";
import { parseRolloutText, previewFromRecord } from "../src/lib/rollout.js";

test("解析消息、工具调用、未知事件和坏行并按时间戳稳定排序", () => {
  const input = [
    JSON.stringify({ timestamp: "2026-01-02T00:00:02Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "ls" } }),
    "{broken",
    JSON.stringify({ timestamp: "2026-01-02T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] } }),
    JSON.stringify({ timestamp: "2026-01-02T00:00:02Z", type: "new_future_event", payload: { keep: true } }),
  ].join("\n");
  const entries = parseRolloutText(input);
  assert.deepEqual(entries.map((entry) => entry.lineNumber), [3, 1, 4, 2]);
  assert.equal(entries[0].kind, "user");
  assert.equal(entries[1].kind, "tool-call");
  assert.equal(entries[1].raw.includes('"function_call"'), true);
  assert.equal(entries[2].title, "new_future_event");
  assert.equal(entries[3].kind, "invalid");
  assert.equal(entries[3].raw, "{broken");
});

test("识别 payload.type 形式的 event_msg", () => {
  const entries = parseRolloutText(JSON.stringify({ timestamp: "2026-02-03T04:05:06Z", type: "event_msg", payload: { type: "user_message", message: "通过 discriminator 字段传入" } }));
  assert.equal(entries[0].kind, "user");
  assert.equal(entries[0].text, "通过 discriminator 字段传入");
  assert.equal(previewFromRecord(entries[0].record), "通过 discriminator 字段传入");
  assert.equal(previewFromRecord({ type: "event_msg", payload: { user_message: { message: "旧形状" } } }), "旧形状");
});
