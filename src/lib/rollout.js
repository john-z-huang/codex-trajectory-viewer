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
    if (event === "mcp_tool_call_end") return { kind: "tool-result", title: `${detail.tool ?? detail.invocation?.name ?? event} · 结果`, contentParts: mcpToolResultParts(detail.result), text: readableFields(detail) };
    if (event === "exec_command_end") return { kind: "tool-result", title: `${detail.command ?? event} · 结果`, text: readableFields(detail) };
    if (event === "item_completed" && detail.item) {
      const eventFields = Object.fromEntries(Object.entries(detail).filter(([key]) => key !== "item"));
      return { kind: "event", title: eventTitles[event], text: `${readableFields(eventFields)}\n已完成项目:\n${responseItemSummary(detail.item).split("\n").map((line) => `  ${line}`).join("\n")}` };
    }
    return { kind: "event", title: eventTitles[event] ?? (event || type), text: readableFields(payload) };
  }
  return { kind: "event", title: recordTitles[type] ?? type, text: readableFields(payload) };
}

/** Parse JSONL without discarding malformed or future event records. */
export function parseRolloutText(source) {
  const entries = source.split(/\r?\n/).flatMap((raw, index) => {
    if (!raw.trim()) return [];
    let record;
    try { record = JSON.parse(raw); }
    catch (error) {
      return [{ lineNumber: index + 1, timestamp: null, kind: "invalid", title: "无法解析的记录", text: error.message, raw, record: null }];
    }
    const view = classify(record);
    return [{ lineNumber: index + 1, timestamp: record.timestamp ?? null, ...view, raw, record }];
  });
  return entries.sort((a, b) => {
    if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp) || a.lineNumber - b.lineNumber;
    if (a.timestamp) return -1;
    if (b.timestamp) return 1;
    return a.lineNumber - b.lineNumber;
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
