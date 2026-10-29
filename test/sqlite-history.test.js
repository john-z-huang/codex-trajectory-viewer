import assert from "node:assert/strict";
import test from "node:test";
import { projectSqliteRow, textChunkOffsets } from "../src/lib/sqlite-history.js";

test("thread_items 会按 Codex payload 类型投影已知内容并保留混合顺序", () => {
  const row = {
    item_type: "userMessage",
    item_json: JSON.stringify({
      type: "userMessage",
      content: [
        { type: "text", text: "**先读这个**" },
        { type: "image", image_url: "https://example.invalid/image.png" },
        { type: "text", text: "再读这个" },
      ],
    }),
    thread_id: "thread-synthetic",
    turn_id: "turn-synthetic",
    item_id: "item-synthetic",
    rollout_ordinal: 7,
    created_at_ms: 1_750_000_000_000,
  };

  const projection = projectSqliteRow("thread_items", row);
  assert.equal(projection.title, "用户消息");
  assert.equal(projection.actor, "用户");
  assert.deepEqual(projection.blocks.map(({ kind, text }) => ({ kind, text })), [
    { kind: "markdown", text: "**先读这个**" },
    { kind: "plain", text: '{\n  "type": "image",\n  "image_url": "https://example.invalid/image.png"\n}' },
    { kind: "markdown", text: "再读这个" },
  ]);
  assert.equal(projection.fields.find(({ label }) => label === "顺序")?.value, "7");
  assert.equal(projection.fields.find(({ label }) => label === "创建时间")?.value, new Date(1_750_000_000_000).toISOString());
});

test("助手回复使用安全 Markdown 投影并保留阶段", () => {
  const projection = projectSqliteRow("thread_items", {
    item_type: "agentMessage",
    item_json: JSON.stringify({ type: "agentMessage", phase: "final_answer", text: "[link](javascript:alert(1))" }),
  });
  assert.equal(projection.title, "助手回复");
  assert.equal(projection.fields.find(({ label }) => label === "阶段")?.value, "final_answer");
  assert.deepEqual(projection.blocks, [{ label: "回复正文", kind: "markdown", text: "[link](javascript:alert(1))" }]);
});

test("命令输出、diff、参数和未知结构保持纯文本", () => {
  const command = projectSqliteRow("thread_items", {
    item_type: "commandExecution",
    item_json: JSON.stringify({
      type: "commandExecution",
      command: "printf '**not markdown**'",
      cwd: "/synthetic/project",
      status: "completed",
      aggregatedOutput: "**plain stdout**",
      exitCode: 0,
    }),
  });
  assert.equal(command.actor, "工具");
  assert.equal(command.fields.find(({ label }) => label === "状态")?.value, "completed");
  assert.equal(command.blocks.find(({ label }) => label === "命令输出")?.kind, "plain");

  const change = projectSqliteRow("thread_items", {
    item_type: "fileChange",
    item_json: JSON.stringify({ type: "fileChange", changes: [{ path: "src/a.js", diff: "**plain diff**" }] }),
  });
  assert.deepEqual(change.blocks, [{ label: "文件：src/a.js", kind: "plain", text: "**plain diff**" }]);

  const unknown = projectSqliteRow("thread_items", {
    item_type: "futurePayload",
    item_json: JSON.stringify({ type: "futurePayload", body: "**unclassified**" }),
  });
  assert.equal(unknown.title, "未知类型：futurePayload");
  assert.ok(unknown.blocks.every(({ kind }) => kind === "plain"));
  assert.match(unknown.blocks[0].text, /打开原始行/);
});

test("MCP 与动态工具按原顺序提取文本项，非文本项作为纯数据保留", () => {
  const mcp = projectSqliteRow("thread_items", {
    item_type: "mcpToolCall",
    item_json: JSON.stringify({
      type: "mcpToolCall",
      server: "synthetic-server",
      tool: "read_note",
      arguments: { path: "note.md" },
      result: { content: [{ type: "text", text: "**note text**" }, { type: "image", url: "https://example.invalid" }] },
    }),
  });
  assert.equal(mcp.fields.find(({ label }) => label === "服务")?.value, "synthetic-server");
  assert.equal(mcp.blocks.find(({ label }) => label === "参数")?.kind, "plain");
  assert.deepEqual(mcp.blocks.filter(({ label }) => label.startsWith("工具结果")).map(({ kind }) => kind), ["markdown", "plain"]);
  assert.match(mcp.blocks.at(-1).text, /example\.invalid/);

  const dynamic = projectSqliteRow("thread_items", {
    item_type: "dynamicToolCall",
    item_json: JSON.stringify({ type: "dynamicToolCall", contentItems: [{ type: "text", text: "dynamic result" }] }),
  });
  assert.deepEqual(dynamic.blocks, [{ label: "工具结果", kind: "markdown", text: "dynamic result" }]);

  const output = projectSqliteRow("thread_items", {
    item_type: "functionCallOutput",
    item_json: JSON.stringify({ type: "functionCallOutput", output: '[{"type":"text","text":"**function result**"}]' }),
  });
  assert.deepEqual(output.blocks, [{ label: "工具结果", kind: "markdown", text: "**function result**" }]);
});

test("损坏或缺失 item_json 不丢行，thread 元数据只选取简明字段", () => {
  const broken = projectSqliteRow("thread_items", { item_type: "userMessage", item_json: "{broken" });
  assert.equal(broken.title, "用户消息");
  assert.equal(broken.warning, "item_json JSON 格式损坏");
  assert.match(broken.blocks[0].text, /原始行仍可查看/);

  const missing = projectSqliteRow("thread_items", { thread_id: "thread-synthetic" });
  assert.equal(missing.warning, "item_json 缺失或不是文本");

  const thread = projectSqliteRow("threads", {
    thread_id: "thread-synthetic",
    cwd: "/synthetic/project",
    title: "Synthetic thread",
    unrecognized_json: "not surfaced as a summary field",
  });
  assert.equal(thread.title, "会话信息");
  assert.deepEqual(thread.fields.map(({ label }) => label), ["thread id", "title", "cwd"]);

  const turn = projectSqliteRow("thread_turns", {
    turn_id: "turn-synthetic",
    started_at: "2026-10-29T09:00:00Z",
    completed_at: "2026-10-29T09:00:30Z",
    duration_ms: 30_000,
  });
  assert.equal(turn.fields.find(({ label }) => label === "started at")?.value, "2026-10-29T09:00:00Z");
  assert.equal(turn.fields.find(({ label }) => label === "completed at")?.value, "2026-10-29T09:00:30Z");
  assert.equal(turn.fields.find(({ label }) => label === "duration ms")?.value, "30000");

  const goal = projectSqliteRow("thread_goals", {
    goal_id: "goal-synthetic",
    title: "Synthetic goal",
    objective: "A large goal body stays accessible as plain text.",
  });
  assert.equal(goal.fields.find(({ label }) => label === "title")?.value, "Synthetic goal");
  assert.deepEqual(goal.blocks, [{ label: "目标正文", kind: "plain", text: "A large goal body stays accessible as plain text." }]);
});

test("对象状态与原型链属性不会破坏卡片投影", () => {
  const objectStatus = projectSqliteRow("thread_items", {
    item_json: JSON.stringify({ type: "agentMessage", text: "safe", status: { bad: true }, phase: "final_answer" }),
  });
  assert.equal(objectStatus.title, "助手回复");
  assert.equal(objectStatus.status, "final_answer");
  assert.equal(typeof objectStatus.status, "string");

  const prototypeType = projectSqliteRow("thread_items", {
    item_type: "__proto__",
    item_json: JSON.stringify({ type: "__proto__", value: "safe raw fallback" }),
  });
  assert.equal(prototypeType.title, "未知类型：__proto__");
  assert.equal(typeof prototypeType.title, "string");

  const prototypeTable = projectSqliteRow("__proto__", { status: { bad: true }, id: "synthetic-id" });
  assert.equal(prototypeTable.title, "__proto__");
  assert.equal(typeof prototypeTable.title, "string");
  assert.equal(prototypeTable.status, "");
  assert.deepEqual(prototypeTable.fields.map(({ label }) => label), ["id"]);
});

test("文本分片有界，拼回后与原文完全一致", () => {
  const text = `${"a".repeat(8_500)}\n${"b".repeat(17_000)}`;
  const offsets = textChunkOffsets(text, 4_000);
  const parts = offsets.slice(0, -1).map((start, index) => text.slice(start, offsets[index + 1]));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 4_000));
  assert.equal(parts.join(""), text);
  assert.deepEqual(textChunkOffsets(""), [0]);

  const emojiText = `${"a".repeat(3)}😀${"b".repeat(7)}`;
  const emojiOffsets = textChunkOffsets(emojiText, 4);
  const emojiParts = emojiOffsets.slice(0, -1).map((start, index) => emojiText.slice(start, emojiOffsets[index + 1]));
  assert.ok(emojiParts.every((part) => part.length <= 4));
  assert.ok(emojiParts.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
  assert.equal(emojiParts.join(""), emojiText);

  const newlineAtBoundary = "abc\nxyz";
  const newlineOffsets = textChunkOffsets(newlineAtBoundary, 4);
  const newlineParts = newlineOffsets.slice(0, -1).map((start, index) => newlineAtBoundary.slice(start, newlineOffsets[index + 1]));
  assert.ok(newlineParts.every((part) => part.length <= 4));
  assert.equal(newlineParts.join(""), newlineAtBoundary);
});
