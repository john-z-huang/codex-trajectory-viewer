import test from "node:test";
import assert from "node:assert/strict";
import { parseRolloutText, previewFromRecord, projectRolloutLines } from "../src/lib/rollout.js";

const syntheticLine = (lineNumber, raw) => ({ lineNumber, byteLength: new TextEncoder().encode(raw).byteLength, raw });

test("解析消息、工具调用、未知事件和坏行并保留物理行顺序", () => {
  const input = [
    JSON.stringify({ timestamp: "2026-01-02T00:00:02Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "ls" } }),
    "{broken",
    JSON.stringify({ timestamp: "2026-01-02T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] } }),
    JSON.stringify({ timestamp: "2026-01-02T00:00:02Z", type: "new_future_event", payload: { keep: true } }),
  ].join("\n");
  const entries = parseRolloutText(input);
  assert.deepEqual(entries.map((entry) => entry.lineNumber), [1, 2, 3, 4]);
  assert.equal(entries[0].kind, "tool-call");
  assert.equal(entries[0].raw.includes('"function_call"'), true);
  assert.equal(entries[1].kind, "invalid");
  assert.equal(entries[1].raw, "{broken");
  assert.equal(entries[2].kind, "user");
  assert.equal(entries[3].title, "new_future_event");
});

test("JSON null、primitive 与深层分类异常逐行保留原记录", () => {
  let deeplyNested = "0";
  for (let index = 0; index < 5000; index += 1) deeplyNested = `{"a":${deeplyNested}}`;
  const deepRaw = `{"type":"future_record","payload":${deeplyNested}}`;
  const input = ["null", "42", '"primitive"', deepRaw, "{broken"].join("\n");

  const entries = parseRolloutText(input);

  assert.deepEqual(entries.map((entry) => entry.lineNumber), [1, 2, 3, 4, 5]);
  assert.deepEqual(entries.slice(0, 3).map((entry) => entry.record), [null, 42, "primitive"]);
  assert.deepEqual(entries.slice(0, 3).map((entry) => entry.text), ["null", "42", "primitive"]);
  assert.equal(entries[3].kind, "invalid");
  assert.equal(entries[3].raw, deepRaw);
  assert.equal(JSON.stringify(entries[3].record), deepRaw);
  assert.equal(entries[4].kind, "invalid");
  assert.equal(entries[4].raw, "{broken");
});

test("轻量页按物理行顺序生成受限卡片并只携带原文 locator", () => {
  const lines = [
    syntheticLine(4, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fixture" }] } })),
    syntheticLine(5, ""),
    syntheticLine(6, "null"),
    syntheticLine(7, "42"),
    syntheticLine(8, "{broken"),
    syntheticLine(9, JSON.stringify({ type: "future_record", payload: { keep: true } })),
  ];

  const entries = projectRolloutLines(lines, { revision: "synthetic-revision", sessionId: "synthetic-session" });

  assert.deepEqual(entries.map((entry) => entry.lineNumber), [4, 5, 6, 7, 8, 9]);
  assert.equal(entries[0].kind, "user");
  assert.equal(entries[0].text, "fixture");
  assert.equal(entries[1].kind, "empty");
  assert.equal(entries[1].text, "（空物理行）");
  assert.equal(entries[2].text, "null");
  assert.equal(entries[3].text, "42");
  assert.equal(entries[4].kind, "invalid");
  assert.equal(entries[5].title, "future_record");
  for (const entry of entries) {
    assert.ok(new TextEncoder().encode(JSON.stringify(entry)).byteLength <= 64 * 1024);
    assert.deepEqual(entry.originalLocator, { lineNumber: entry.lineNumber, revision: "synthetic-revision", sessionId: "synthetic-session" });
    assert.equal(Object.hasOwn(entry, "raw"), false);
    assert.equal(Object.hasOwn(entry, "record"), false);
    assert.equal(Object.hasOwn(entry, "contents"), false);
  }
});

test("轻量标题预览限制为 256 个 UTF-16 单位并显式标记省略，完整原文仍可定位", () => {
  const toolName = `${"x".repeat(254)}😀${"long-name-".repeat(100)}`;
  const raw = JSON.stringify({ type: "response_item", payload: { type: "function_call", name: toolName, arguments: "{}" } });
  const [entry] = projectRolloutLines([syntheticLine(65, raw)], { revision: "title-revision", sessionId: "synthetic-session" });

  assert.equal(entry.title, `${"x".repeat(254)}…`, "preview ends before a surrogate pair and uses an ellipsis");
  assert.ok(entry.title.length <= 256);
  assert.equal(entry.titleTruncated, true);
  assert.deepEqual(entry.originalLocator, { lineNumber: 65, revision: "title-revision", sessionId: "synthetic-session" });
  assert.equal(entry.text, "{}");
  assert.equal(Object.hasOwn(entry, "raw"), false, "full raw text remains available through the locator rather than the projection");
});

test("轻量页最多投影 32 行，超长、超深、节点过多和派生过大记录提供原文入口", () => {
  const page = Array.from({ length: 40 }, (_, index) => ({ lineNumber: index + 1, raw: JSON.stringify({ type: "future_record", payload: { index } }) }));
  const view = projectRolloutLines(page, { revision: "rev" });
  assert.equal(view.length, 32);
  assert.equal(view.at(-1).lineNumber, 32);

  let deepValue = "0";
  for (let index = 0; index < 33; index += 1) deepValue = `{"a":${deepValue}}`;
  const tooDeep = JSON.stringify({ type: "future_record", payload: JSON.parse(deepValue) });
  const tooManyNodes = JSON.stringify({ type: "future_record", payload: { items: Array.from({ length: 4097 }, () => 0) } });
  let expandedValue = Array.from({ length: 1100 }, () => "x");
  for (let index = 0; index < 30; index += 1) expandedValue = [expandedValue];
  const derivedTooLarge = JSON.stringify({ type: "future_record", payload: { nested: expandedValue } });

  const limited = projectRolloutLines([
    { lineNumber: 1, byteLength: 70 * 1024, oversized: true },
    { lineNumber: 2, raw: tooDeep },
    { lineNumber: 3, raw: tooManyNodes },
    { lineNumber: 4, raw: derivedTooLarge },
  ], { revision: "rev" });

  assert.equal(limited[0].oversized, true);
  assert.equal(limited[1].projectionLimited, true);
  assert.equal(limited[2].projectionLimited, true);
  assert.equal(limited[3].projectionLimited, true);
  assert.ok(limited.every((entry) => entry.originalLocator.revision === "rev"));
  assert.ok(limited.every((entry) => !Object.hasOwn(entry, "raw") && !Object.hasOwn(entry, "record")));
});

test("畸形但合法的 JSON 展示字段会降级为原文 descriptor", () => {
  const records = [
    { type: {} },
    { type: "response_item", payload: { type: "function_call", name: { bad: true }, arguments: { raw: "object" } } },
    { type: "event_msg", payload: { exec_command_begin: { command: ["echo", "x"] } } },
  ];
  const projected = projectRolloutLines(records.map((record, index) => syntheticLine(index + 1, JSON.stringify(record))), { revision: "rev" });

  assert.equal(projected.length, records.length);
  for (const entry of projected) {
    assert.equal(entry.projectionLimited, true);
    assert.equal(entry.originalLocator.revision, "rev");
    assert.equal(typeof entry.title, "string");
    assert.equal(typeof entry.text, "string");
    assert.equal(Object.hasOwn(entry, "raw"), false);
    assert.equal(Object.hasOwn(entry, "record"), false);
  }
});

test("识别 payload.type 形式的 event_msg", () => {
  const entries = parseRolloutText(JSON.stringify({ timestamp: "2026-02-03T04:05:06Z", type: "event_msg", payload: { type: "user_message", message: "通过 discriminator 字段传入" } }));
  assert.equal(entries[0].kind, "user");
  assert.equal(entries[0].text, "通过 discriminator 字段传入");
  assert.equal(previewFromRecord(entries[0].record), "通过 discriminator 字段传入");
  assert.equal(previewFromRecord({ type: "event_msg", payload: { user_message: { message: "旧形状" } } }), "旧形状");
});

test("展示当前 rollout 中的常见事件及元数据 payload", () => {
  const cases = [
    ["event_msg", { type: "task_started", turn_id: "turn-1", started_at: "2026-02-03T04:05:06Z", root_turn_id: "root-turn-1", model_context_window: 128000, collaboration_mode_kind: "pair" }, "回合开始", ["回合 ID: turn-1", "根回合 ID: root-turn-1", "开始时间: 2026-02-03T04:05:06Z", "模型上下文窗口: 128000", "协作模式: pair"]],
    ["response_item", { type: "additional_tools", role: "assistant", tools: [{ name: "search", description: "find" }] }, "附加工具", ["角色: assistant", "工具列表", "名称: search", "说明: find"]],
    ["world_state", { full: true, state: { cwd: "/synthetic/project", branch: "demo" } }, "世界状态", ["完整状态: true", "状态:", "工作目录: /synthetic/project", "分支: demo"]],
    ["event_msg", { type: "thread_settings_applied", thread_id: "thread-1", thread_settings: { model: "test-model", approval_policy: "never" } }, "会话设置已应用", ["线程 ID: thread-1", "线程设置:", "模型: test-model", "审批策略: never"]],
    ["event_msg", { type: "item_completed", thread_id: "thread-1", turn_id: "turn-1", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture" }] }, started_at_ms: 10, completed_at_ms: 20 }, "项目完成", ["线程 ID: thread-1", "回合 ID: turn-1", "已完成项目:", "类型: 消息", "角色: assistant", "内容:", "fixture（类型: output_text）"]],
    ["response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "fixture summary" }], content: [{ type: "reasoning_text", text: "fixture reasoning" }], encrypted_content: null }, "推理内容", ["摘要:", "fixture summary", "内容:", "fixture reasoning", "加密内容: 无"]],
    ["token_usage_record", { thread_id: "thread-1", turn_id: "turn-1", session_id: "session-1", root_turn_id: "root-turn-1", response_id: "response-1", usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, turn_token_usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, thread_token_usage: { input_tokens: 24, output_tokens: 6, total_tokens: 30 } }, "Token 用量记录", ["线程 ID: thread-1", "回合 ID: turn-1", "会话 ID: session-1", "根回合 ID: root-turn-1", "响应 ID: response-1", "用量:", "输入 token 数: 12", "本回合用量:", "线程用量:", "总 token 数: 30"]],
  ];

  for (const [type, payload, title, expectedText] of cases) {
    const record = { type, payload };
    const [entry] = parseRolloutText(JSON.stringify(record));
    assert.equal(entry.title, title, `${type}/${payload.type ?? ""} title`);
    for (const expected of expectedText) assert.ok(entry.text.includes(expected), `${type} should show ${expected}`);
    assert.notEqual(entry.text, JSON.stringify(payload, null, 2), `${type} should be summarized rather than dumped as JSON`);
    assert.equal(entry.markdown, undefined, `${type}/${payload.type ?? ""} stays plain text`);
    assert.deepEqual(entry.record, record);
    assert.equal(entry.raw, JSON.stringify(record));
  }
});

test("未知 discriminator 保留完整 payload，旧 keyed event 仍可识别并保留原文", () => {
  const unknown = { type: "response_item", payload: { type: "future_item", nested: { value: [1, 2] } } };
  const legacy = { type: "event_msg", payload: { task_started: { turn_id: "old-turn", detail: true } } };
  const entries = parseRolloutText([JSON.stringify(unknown), JSON.stringify(legacy)].join("\n"));

  assert.equal(entries[0].title, "future_item");
  assert.match(entries[0].text, /类型: future_item/);
  assert.match(entries[0].text, /nested:/);
  assert.match(entries[0].text, /value:/);
  assert.equal(entries[0].markdown, undefined);
  assert.equal(entries[1].title, "回合开始");
  assert.match(entries[1].text, /回合 ID: old-turn/);
  assert.match(entries[1].text, /detail: true/);
  assert.equal(entries[1].raw, JSON.stringify(legacy));
});

test("turn_context 和未知 rollout 外层类型展示 payload，而非空白", () => {
  const records = [
    { type: "turn_context", payload: { cwd: "/synthetic/project", approval_policy: "never" } },
    { type: "future_record", payload: { nested: { preserve: true } } },
  ];
  const entries = parseRolloutText(records.map(JSON.stringify).join("\n"));
  assert.equal(entries[0].title, "运行上下文");
  assert.match(entries[0].text, /工作目录: \/synthetic\/project/);
  assert.match(entries[0].text, /审批策略: never/);
  assert.equal(entries[1].title, "future_record");
  assert.match(entries[1].text, /nested:/);
  assert.match(entries[1].text, /preserve: true/);
});

test("MCP 文本结果只保留 contentParts 展示投影，不生成重复 text", () => {
  const record = {
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      tool: "synthetic-tool",
      result: { content: [{ type: "text", text: "# Synthetic result" }, { type: "image", data: "opaque" }] },
    },
  };
  const [entry] = parseRolloutText(JSON.stringify(record));

  assert.equal(entry.kind, "tool-result");
  assert.deepEqual(entry.contentParts, [{ kind: "markdown", text: "# Synthetic result" }, { kind: "plain", text: '{\n  "type": "image",\n  "data": "opaque"\n}' }]);
  assert.equal(Object.hasOwn(entry, "text"), false);
  assert.equal(entry.raw, JSON.stringify(record));
  assert.deepEqual(entry.record, record);
});
