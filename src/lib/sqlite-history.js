import { mcpToolResultParts, toolOutputParts } from "./markdown-content.js";

export const SQLITE_TEXT_CHUNK_SIZE = 8_000;

const ITEM_LABELS = Object.freeze({
  userMessage: "用户消息",
  agentMessage: "助手回复",
  reasoning: "助手思考",
  commandExecution: "命令执行",
  fileChange: "文件变更",
  mcpToolCall: "MCP 工具调用",
  dynamicToolCall: "动态工具调用",
  functionCallOutput: "工具结果",
});

const TABLE_LABELS = Object.freeze({
  threads: "会话信息",
  thread_turns: "会话轮次",
  thread_goals: "关联目标",
});

const SUMMARY_FIELDS = Object.freeze({
  threads: ["thread_id", "id", "title", "cwd", "model", "source", "created_at_ms", "updated_at_ms"],
  thread_turns: ["turn_id", "thread_id", "status", "cwd", "started_at", "completed_at", "started_at_ms", "completed_at_ms", "duration_ms"],
  thread_goals: ["goal_id", "id", "thread_id", "title", "status", "created_at_ms", "updated_at_ms"],
});

const TIMESTAMP_FIELDS = new Set(["created_at_ms", "updated_at_ms", "started_at_ms", "completed_at_ms"]);

function stringify(value) {
  if (typeof value === "string") return value;
  try {
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

function ownValue(record, key) {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function statusText(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function timestampValue(value, key) {
  if (value == null || value === "") return null;
  if (key.endsWith("_ms") && Number.isFinite(Number(value))) {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return String(value);
}

function metadataField(label, value, key = "") {
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  return { label, value: TIMESTAMP_FIELDS.has(key) ? timestampValue(value, key) : String(value) };
}

function pushField(fields, label, value, key = "") {
  const field = metadataField(label, value, key);
  if (field) fields.push(field);
}

function plainBlock(label, value) {
  if (value == null || value === "") return null;
  return { label, kind: "plain", text: stringify(value) };
}

function textBlocks(label, value, kind = "plain") {
  if (value == null || value === "") return [];
  if (typeof value === "string") return [{ label, kind, text: value }];
  if (!Array.isArray(value)) return [{ label, kind: "plain", text: stringify(value) }];
  return value.flatMap((item, index) => {
    if (typeof item === "string") return [{ label: value.length > 1 ? `${label} ${index + 1}` : label, kind, text: item }];
    const itemLabel = value.length > 1 ? `${label} ${index + 1}` : label;
    return [plainBlock(itemLabel, item)].filter(Boolean);
  });
}

function userContentBlocks(content) {
  if (typeof content === "string") return textBlocks("消息正文", content, "markdown");
  if (!Array.isArray(content)) return [plainBlock("消息内容", content)].filter(Boolean);
  return content.flatMap((item, index) => {
    const label = content.length > 1 ? `消息内容 ${index + 1}` : "消息正文";
    if (typeof item === "string") return [{ label, kind: "markdown", text: item }];
    const isText = item && typeof item === "object"
      && ["text", "inputText", "input_text"].includes(item.type)
      && typeof item.text === "string";
    return isText
      ? [{ label, kind: "markdown", text: item.text }]
      : [plainBlock(label, item)].filter(Boolean);
  });
}

function toolResultBlocks(label, value) {
  return mcpToolResultParts(value).map((part, index) => ({
    label: index ? `${label} ${index + 1}` : label,
    kind: part.kind === "markdown" ? "markdown" : "plain",
    text: part.text,
  }));
}

function parseItemPayload(row) {
  const source = row?.item_json;
  if (source && typeof source === "object") return { payload: source, error: "" };
  if (typeof source !== "string" || source.length === 0) {
    return { payload: null, error: "item_json 缺失或不是文本" };
  }
  try {
    const payload = JSON.parse(source);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { payload: null, error: "item_json 不是对象" };
    }
    return { payload, error: "" };
  } catch {
    return { payload: null, error: "item_json JSON 格式损坏" };
  }
}

function itemProjection(row) {
  const { payload, error } = parseItemPayload(row);
  const type = typeof payload?.type === "string" && payload.type
    ? payload.type
    : typeof row?.item_type === "string" && row.item_type
      ? row.item_type
      : "unknown";
  const fields = [];
  const blocks = [];
  const actor = type === "userMessage"
    ? "用户"
    : ["agentMessage", "reasoning"].includes(type)
      ? "助手"
      : ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "functionCallOutput"].includes(type)
        ? "工具"
        : "SQLite 项目";

  pushField(fields, "类型", row?.item_type ?? type);
  pushField(fields, "thread_id", row?.thread_id);
  pushField(fields, "turn_id", row?.turn_id);
  pushField(fields, "item_id", row?.item_id);
  pushField(fields, "顺序", row?.rollout_ordinal);
  pushField(fields, "创建时间", row?.created_at_ms, "created_at_ms");
  pushField(fields, "开始时间", row?.started_at_ms, "started_at_ms");
  pushField(fields, "结束时间", row?.completed_at_ms, "completed_at_ms");

  if (error) {
    blocks.push({ label: "内容状态", kind: "plain", text: `${error}；原始行仍可查看。` });
  } else {
    switch (type) {
      case "userMessage":
        blocks.push(...userContentBlocks(payload.content));
        break;
      case "agentMessage":
        pushField(fields, "阶段", payload.phase);
        blocks.push(...textBlocks("回复正文", payload.text, "markdown"));
        break;
      case "reasoning":
        blocks.push(...textBlocks("摘要", payload.summary));
        blocks.push(...textBlocks("内容", payload.content));
        break;
      case "commandExecution":
        pushField(fields, "状态", payload.status);
        pushField(fields, "退出码", payload.exitCode);
        pushField(fields, "耗时", payload.durationMs == null ? null : `${payload.durationMs} ms`);
        blocks.push(plainBlock("命令", payload.command));
        blocks.push(plainBlock("工作目录", payload.cwd));
        blocks.push(plainBlock("命令输出", payload.aggregatedOutput));
        break;
      case "fileChange": {
        pushField(fields, "状态", payload.status);
        const changes = Array.isArray(payload.changes) ? payload.changes : [];
        blocks.push(...changes.flatMap((change, index) => {
          const path = change?.path ?? change?.filePath ?? `变更 ${index + 1}`;
          const parts = [];
          const label = `文件：${String(path)}`;
          if (change?.diff != null) parts.push(plainBlock(label, change.diff));
          else parts.push(plainBlock(label, change));
          return parts.filter(Boolean);
        }));
        if (!changes.length) blocks.push(plainBlock("变更", payload.changes ?? payload.diff));
        break;
      }
      case "mcpToolCall":
        pushField(fields, "服务", payload.server);
        pushField(fields, "工具", payload.tool);
        pushField(fields, "状态", payload.status ?? (payload.error ? "失败" : null));
        blocks.push(plainBlock("参数", payload.arguments));
        if (payload.result != null) blocks.push(...toolResultBlocks("工具结果", payload.result));
        blocks.push(plainBlock("错误", payload.error));
        break;
      case "dynamicToolCall":
        pushField(fields, "工具", payload.tool ?? payload.name);
        pushField(fields, "状态", payload.status);
        blocks.push(plainBlock("参数", payload.arguments));
        if (Array.isArray(payload.contentItems)) {
          blocks.push(...toolResultBlocks("工具结果", { content: payload.contentItems }));
        } else {
          blocks.push(plainBlock("工具结果", payload.contentItems));
        }
        break;
      case "functionCallOutput":
        blocks.push(...toolOutputParts(payload.output).map((part, index) => ({
          label: index ? `工具结果 ${index + 1}` : "工具结果",
          kind: part.kind === "markdown" ? "markdown" : "plain",
          text: part.text,
        })));
        break;
      default:
        blocks.push({
          label: "内容状态",
          kind: "plain",
          text: `尚不支持“${type}”类型；可打开原始行查看全部字段。`,
        });
    }
  }

  return {
    title: ownValue(ITEM_LABELS, type) ?? (type === "unknown" ? "未知 SQLite 项目" : `未知类型：${type}`),
    actor,
    status: statusText(payload?.status) || statusText(payload?.phase),
    fields,
    blocks: blocks.filter(Boolean),
    warning: error,
  };
}

function summaryProjection(table, row) {
  const fields = [];
  const blocks = [];
  const preferred = ownValue(SUMMARY_FIELDS, table) ?? [
    "thread_id", "turn_id", "goal_id", "item_id", "id", "title", "status", "created_at_ms", "updated_at_ms",
  ];
  for (const key of preferred) {
    if (!Object.hasOwn(row ?? {}, key)) continue;
    const label = key.replaceAll("_", " ");
    pushField(fields, label, row[key], key);
  }
  if (table === "thread_goals" && row?.objective != null && row.objective !== "") {
    blocks.push(plainBlock("目标正文", row.objective));
  }
  return {
    title: ownValue(TABLE_LABELS, table) ?? (typeof table === "string" ? table : "SQLite 记录"),
    actor: "SQLite 元数据",
    status: statusText(row?.status),
    fields,
    blocks,
    warning: "",
  };
}

/** 生成可安全展示的摘要，原始行由查看入口单独保留。 */
export function projectSqliteRow(table, row) {
  if (table === "thread_items") return itemProjection(row ?? {});
  return summaryProjection(table, row ?? {});
}

/** 仅返回分段偏移，使文本有界展示且不复制完整内容。 */
export function textChunkOffsets(value, chunkSize = SQLITE_TEXT_CHUNK_SIZE) {
  const text = String(value ?? "");
  const size = Number.isSafeInteger(chunkSize) && chunkSize > 0
    ? Math.max(2, chunkSize)
    : SQLITE_TEXT_CHUNK_SIZE;
  const offsets = [0];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end -= 1;
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= start + Math.floor(size / 2)) end = newline + 1;
    }
    if (end <= start) end = Math.min(text.length, start + size);
    offsets.push(end);
    start = end;
  }
  return offsets;
}
