import { mcpToolResultParts, toolOutputParts } from "./markdown-content.js";

const textFrom = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.text ?? item?.content ?? "").filter(Boolean).join("\n");
  return "";
};

const fieldLabels = {
  type: "类型", role: "角色", name: "名称", description: "说明", tools: "工具列表",
  model: "模型", approval_policy: "审批策略",
  thread_id: "线程 ID", turn_id: "回合 ID", session_id: "会话 ID", root_turn_id: "根回合 ID",
  response_id: "响应 ID", started_at: "开始时间", started_at_ms: "开始时间（毫秒）",
  completed_at_ms: "完成时间（毫秒）", trace_id: "追踪 ID", model_context_window: "模型上下文窗口",
  collaboration_mode_kind: "协作模式",
  collaboration_mode_kind: "协作模式", full: "完整状态", state: "状态", thread_settings: "线程设置",
  summary: "摘要", content: "内容", encrypted_content: "加密内容", input_tokens: "输入 token 数",
  output_tokens: "输出 token 数", total_tokens: "总 token 数", cached_input_tokens: "缓存输入 token 数",
  reasoning_output_tokens: "推理输出 token 数", usage: "用量", turn_token_usage: "本回合用量",
  thread_token_usage: "线程用量", arguments: "参数", input: "输入", output: "输出",
  item: "已完成项目", message: "消息", cwd: "工作目录", branch: "分支",
};

const fieldLabel = (key) => fieldLabels[key] ?? key.replaceAll("_", " ");

function readableFields(value, depth = 0) {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(空列表)`;
    return value.map((item) => {
      if (item && typeof item === "object") return `${indent}-\n${readableFields(item, depth + 1)}`;
      return `${indent}- ${item === null ? "null" : String(item)}`;
    }).join("\n");
  }
  if (!value || typeof value !== "object") return `${indent}${value === null ? "null" : String(value ?? "")}`;
  const lines = Object.entries(value).map(([key, item]) => {
    const label = `${indent}${fieldLabel(key)}`;
    if (Array.isArray(item)) return `${label}:\n${readableFields(item, depth + 1)}`;
    if (item && typeof item === "object") return `${label}:\n${readableFields(item, depth + 1)}`;
    return `${label}: ${item === null ? "null" : String(item)}`;
  });
  return lines.length ? lines.join("\n") : `${indent}(无字段)`;
}

function reasoningSummary(item) {
  const lines = [];
  for (const field of ["summary", "content"]) {
    const value = item[field];
    if (value === undefined) continue;
    const segments = Array.isArray(value) ? value : [value];
    lines.push(`${fieldLabel(field)}:`);
    for (const segment of segments) {
      if (typeof segment === "string") lines.push(`  - ${segment}`);
      else if (segment && typeof segment === "object" && typeof segment.text === "string") {
        lines.push(`  - ${segment.text}${segment.type ? `（${fieldLabel("type")}: ${segment.type}）` : ""}`);
        const extra = Object.fromEntries(Object.entries(segment).filter(([key]) => key !== "text" && key !== "type"));
        if (Object.keys(extra).length) lines.push(readableFields(extra, 2));
      } else lines.push(readableFields(segment, 1));
    }
  }
  if (item.encrypted_content !== undefined) {
    lines.push(`加密内容: ${item.encrypted_content ? "存在加密内容（内容不在摘要中展开）" : "无"}`);
  }
  const extra = Object.fromEntries(Object.entries(item).filter(([key]) => !["type", "summary", "content", "encrypted_content"].includes(key)));
  if (Object.keys(extra).length) lines.push(readableFields(extra));
  return lines.join("\n") || "(无可显示的推理文本)";
}

function responseContentSummary(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return readableFields(content);
  if (!content.length) return "(空列表)";
  return content.map((part) => {
    if (typeof part === "string") return `  - ${part}`;
    if (part && typeof part === "object" && typeof part.text === "string") {
      const suffix = part.type ? `（${fieldLabel("type")}: ${part.type}）` : "";
      const extra = Object.fromEntries(Object.entries(part).filter(([key]) => key !== "text" && key !== "type"));
      return [`  - ${part.text}${suffix}`, Object.keys(extra).length ? readableFields(extra, 2) : ""].filter(Boolean).join("\n");
    }
    return `  -\n${readableFields(part, 2)}`;
  }).join("\n");
}

function responseItemSummary(item) {
  if (!item || typeof item !== "object") return readableFields(item);
  if (item.type === "reasoning") return `类型: 推理内容\n${reasoningSummary(item)}`;
  if (item.type === "message") {
    const content = responseContentSummary(item.content);
    const extra = Object.fromEntries(Object.entries(item).filter(([key]) => !["type", "role", "content"].includes(key)));
    return ["类型: 消息", `角色: ${item.role ?? "未知"}`, `内容:\n${content || "  (无文本内容)"}`, Object.keys(extra).length ? readableFields(extra) : ""].filter(Boolean).join("\n");
  }
  return readableFields(item);
}

const recordTitles = {
  task_started: "回合开始",
  additional_tools: "附加工具",
  world_state: "世界状态",
  thread_settings_applied: "会话设置已应用",
  item_completed: "项目完成",
  reasoning: "推理事件",
  token_usage_record: "Token 用量记录",
  turn_context: "运行上下文",
  compacted: "上下文压缩",
  inter_agent_communication: "代理间通信",
  retained_context: "保留上下文",
  security_risk_score: "安全风险评分",
  realtime_item: "实时项目",
};

const eventTitles = {
  task_started: "回合开始",
  turn_started: "回合开始",
  thread_settings_applied: "会话设置已应用",
  item_completed: "项目完成",
  reasoning: "推理事件",
};

function classify(record) {
  if (record === null || typeof record !== "object") return primitiveView(record);
  if (Array.isArray(record)) return primitiveView(record);
  const type = record?.type ?? "unknown";
  const payload = record?.payload ?? {};
  if (type === "session_meta" || type === "session_meta_entry") return { kind: "metadata", title: "会话元数据", text: textFrom(payload.initial_user_message) };
  if (type === "response_item") {
    const item = payload;
    if (item.type === "message") return { kind: item.role === "user" ? "user" : "assistant", title: item.role === "user" ? "用户消息" : "助手消息", text: textFrom(item.content), markdown: true };
    if (item.type === "function_call" || item.type === "custom_tool_call") return { kind: "tool-call", title: item.name ?? item.type, text: item.arguments ?? item.input ?? "" };
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return { kind: "tool-result", title: `${item.name ?? "工具"} · 结果`, contentParts: toolOutputParts(item.output ?? item.content ?? "") };
    return { kind: "event", title: item.type === "additional_tools" ? "附加工具" : item.type === "reasoning" ? "推理内容" : item.type ?? "response_item", text: item.type === "reasoning" ? reasoningSummary(item) : readableFields(item) };
  }
  if (type === "event_msg") {
    const event = payload && typeof payload === "object" ? payload.type ?? Object.keys(payload)[0] : "";
    const detail = payload?.type ? payload : payload?.[event] ?? {};
    if (event === "user_message") return { kind: "user", title: "用户消息", text: textFrom(detail.message ?? detail.content), markdown: true };
    if (event === "agent_message") return { kind: "assistant", title: "助手消息", text: textFrom(detail.message ?? detail.content), markdown: true };
    if (event === "exec_command_begin" || event === "mcp_tool_call_begin") return { kind: "tool-call", title: detail.command ?? detail.tool ?? event, text: readableFields(detail) };
    if (event === "mcp_tool_call_end") return { kind: "tool-result", title: `${detail.tool ?? detail.invocation?.name ?? event} · 结果`, contentParts: mcpToolResultParts(detail.result) };
    if (event === "exec_command_end") return { kind: "tool-result", title: `${detail.command ?? event} · 结果`, text: readableFields(detail) };
    if (event === "item_completed" && detail.item) {
      const eventFields = Object.fromEntries(Object.entries(detail).filter(([key]) => key !== "item"));
      return { kind: "event", title: eventTitles[event], text: `${readableFields(eventFields)}\n已完成项目:\n${responseItemSummary(detail.item).split("\n").map((line) => `  ${line}`).join("\n")}` };
    }
    return { kind: "event", title: eventTitles[event] ?? (event || type), text: readableFields(payload) };
  }
  return { kind: "event", title: recordTitles[type] ?? type, text: readableFields(payload) };
}

const MAX_ROLLOUT_PAGE_LINES = 32;
const MAX_PROJECTION_DEPTH = 32;
const MAX_PROJECTION_NODES = 4096;
const MAX_PROJECTION_BYTES = 64 * 1024;
const MAX_PROJECTION_TITLE_LENGTH = 256;
const MAX_LOCATOR_FIELD_LENGTH = 512;
const projectionEncoder = new TextEncoder();

function byteLengthOf(value) {
  return projectionEncoder.encode(value).byteLength;
}

function normalizedLineNumber(line, index) {
  return Number.isSafeInteger(line?.lineNumber) && line.lineNumber > 0 ? line.lineNumber : index + 1;
}

function timestampFor(record) {
  if (!record || typeof record !== "object") return null;
  const timestamp = record.timestamp;
  if (typeof timestamp === "string") return timestamp.length <= MAX_LOCATOR_FIELD_LENGTH ? timestamp : null;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  return null;
}

function legacyTimestamp(record) {
  return record && typeof record === "object" ? record.timestamp ?? null : null;
}

function locatorFor({ revision, sessionId }, lineNumber) {
  const locator = { lineNumber };
  if ((typeof revision === "string" || typeof revision === "number") && String(revision).length <= MAX_LOCATOR_FIELD_LENGTH) {
    locator.revision = revision;
  }
  if (typeof sessionId === "string" && sessionId.length <= MAX_LOCATOR_FIELD_LENGTH) {
    locator.sessionId = sessionId;
  }
  return locator;
}

function treeExceedsProjectionLimits(root) {
  const pending = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    nodes += 1;
    if (nodes > MAX_PROJECTION_NODES || depth > MAX_PROJECTION_DEPTH) return true;
    if (value && typeof value === "object") {
      const children = Array.isArray(value) ? value : Object.values(value);
      for (const child of children) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

function primitiveView(record) {
  if (record === null) return { kind: "event", title: "JSON null", text: "null" };
  if (Array.isArray(record)) return { kind: "event", title: "JSON 数组", text: readableFields(record) };
  return { kind: "event", title: "JSON 原始值", text: String(record) };
}

function normalizeProjectionView(view) {
  if (!view || typeof view !== "object" || Array.isArray(view)) return null;
  if (typeof view.kind !== "string" || typeof view.title !== "string" && typeof view.title !== "number" && typeof view.title !== "boolean") return null;
  if (view.text !== undefined && typeof view.text !== "string" && typeof view.text !== "number" && typeof view.text !== "boolean") return null;
  if (view.markdown !== undefined && typeof view.markdown !== "boolean") return null;
  if (view.contentParts !== undefined && !Array.isArray(view.contentParts)) return null;

  let title = String(view.title);
  let titleTruncated = false;
  if (title.length > MAX_PROJECTION_TITLE_LENGTH) {
    let end = MAX_PROJECTION_TITLE_LENGTH - 1;
    const lastIncluded = title.charCodeAt(end - 1);
    const firstExcluded = title.charCodeAt(end);
    if (lastIncluded >= 0xd800 && lastIncluded <= 0xdbff && firstExcluded >= 0xdc00 && firstExcluded <= 0xdfff) end -= 1;
    title = `${title.slice(0, end)}…`;
    titleTruncated = true;
  }

  let contentParts;
  if (view.contentParts) {
    contentParts = [];
    for (const part of view.contentParts) {
      if (!part || typeof part !== "object" || Array.isArray(part) || typeof part.text !== "string") return null;
      if (part.kind !== undefined && typeof part.kind !== "string") return null;
      contentParts.push({ ...(part.kind === undefined ? {} : { kind: part.kind }), text: part.text });
    }
  }

  return {
    kind: view.kind,
    title,
    ...(titleTruncated ? { titleTruncated: true } : {}),
    ...(view.text === undefined ? {} : { text: String(view.text) }),
    ...(contentParts === undefined ? {} : { contentParts }),
    ...(view.markdown === undefined ? {} : { markdown: view.markdown }),
  };
}

function limitedProjection(lineNumber, originalLocator, reason, { timestamp = null, oversized = false } = {}) {
  return {
    lineNumber,
    timestamp,
    kind: "oversized",
    title: oversized ? "记录超过预览上限" : "记录预览受限",
    text: reason,
    ...(oversized ? { oversized: true } : { projectionLimited: true }),
    originalLocator,
  };
}

function invalidProjection(lineNumber, originalLocator, message) {
  return {
    lineNumber,
    timestamp: null,
    kind: "invalid",
    title: "无法解析的记录",
    text: String(message || "无法识别该记录").slice(0, 240),
    originalLocator,
  };
}

function projectRolloutLine(line, index, context) {
  const lineNumber = normalizedLineNumber(line, index);
  const originalLocator = locatorFor(context, lineNumber);
  const raw = line?.raw;
  const reportedByteLength = Number.isSafeInteger(line?.byteLength) && line.byteLength >= 0 ? line.byteLength : null;

  if (line?.oversized || (reportedByteLength !== null && reportedByteLength > MAX_PROJECTION_BYTES) || (typeof raw === "string" && byteLengthOf(raw) > MAX_PROJECTION_BYTES)) {
    return limitedProjection(lineNumber, originalLocator, "此行超过轻量预览上限；可通过原文入口读取完整内容。", { oversized: true });
  }
  if (typeof raw !== "string") {
    return invalidProjection(lineNumber, originalLocator, "当前页未提供原始行内容；可通过原文入口重新读取。");
  }
  if (raw === "") {
    return {
      lineNumber,
      timestamp: null,
      kind: "empty",
      title: "空行",
      text: "（空物理行）",
      originalLocator,
    };
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    return invalidProjection(lineNumber, originalLocator, error?.message ?? "无效 JSON");
  }

  if (treeExceedsProjectionLimits(record)) {
    return limitedProjection(lineNumber, originalLocator, "此行的 JSON 深度或节点数超过轻量预览上限；可通过原文入口读取完整内容。");
  }

  try {
    const rawView = classify(record);
    const view = normalizeProjectionView(rawView);
    if (!view) {
      return limitedProjection(lineNumber, originalLocator, "此行包含无法安全显示的结构字段；可通过原文入口读取完整内容。");
    }
    const projected = {
      lineNumber,
      timestamp: timestampFor(record),
      ...view,
      originalLocator,
    };
    const serialized = JSON.stringify(projected);
    if (byteLengthOf(serialized) > MAX_PROJECTION_BYTES) {
      return limitedProjection(lineNumber, originalLocator, "此行的展示投影超过 64 KiB；可通过原文入口读取完整内容。", { timestamp: projected.timestamp });
    }
    return projected;
  } catch (error) {
    return invalidProjection(lineNumber, originalLocator, `无法生成记录预览：${error?.message ?? "未知错误"}`);
  }
}

/**
 * Build a bounded page view without retaining source rows or parsed records.
 * The server owns the physical-line page size; this helper defensively accepts
 * at most 32 rows, matching the page API contract.
 */
export function projectRolloutLines(lines, { revision, sessionId } = {}) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, MAX_ROLLOUT_PAGE_LINES).map((line, index) => projectRolloutLine(line, index, { revision, sessionId }));
}

function parseRawLine(raw, lineNumber) {
  if (!raw.trim()) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    return { lineNumber, timestamp: null, kind: "invalid", title: "无法解析的记录", text: error?.message ?? "无效 JSON", raw, record: null };
  }

  try {
    const view = classify(record);
    return { lineNumber, timestamp: legacyTimestamp(record), ...view, raw, record };
  } catch (error) {
    return {
      lineNumber,
      timestamp: legacyTimestamp(record),
      kind: "invalid",
      title: "无法生成记录展示",
      text: error?.message ?? "未知错误",
      raw,
      record,
    };
  }
}

/** Parse JSONL in physical line order without discarding malformed records. */
export function parseRolloutText(source) {
  return source.split(/\r?\n/).flatMap((raw, index) => {
    const entry = parseRawLine(raw, index + 1);
    return entry ? [entry] : [];
  });
}

export function previewFromRecord(record) {
  if (record?.type === "session_meta") return textFrom(record.payload?.initial_user_message);
  if (record?.type === "response_item" && record.payload?.type === "message" && record.payload?.role === "user") return textFrom(record.payload.content);
  if (record?.type === "event_msg") {
    const payload = record.payload ?? {};
    if (payload.type === "user_message") return textFrom(payload.message ?? payload.content);
    if (payload.user_message) return textFrom(payload.user_message.message ?? payload.user_message.content);
  }
  return "";
}
