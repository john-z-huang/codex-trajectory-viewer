const leaf = (value, label) => ({ value, label });
const group = (value, label, children, fallback) => ({ value, label, children, fallback });

export const JSONL_RECORD_TYPES = Object.freeze([
  group("user", "用户消息", [
    leaf("user/message", "用户消息记录"), leaf("user/event", "用户消息事件"), leaf("user/other", "其他用户消息"),
  ], "user/other"),
  group("assistant", "助手消息", [
    leaf("assistant/message", "助手消息记录"), leaf("assistant/event", "助手消息事件"), leaf("assistant/other", "其他助手消息"),
  ], "assistant/other"),
  group("tool-call", "工具调用", [
    leaf("tool-call/function", "函数调用"), leaf("tool-call/custom", "自定义工具调用"),
    leaf("tool-call/command", "命令开始"), leaf("tool-call/mcp", "MCP 调用开始"), leaf("tool-call/other", "其他工具调用"),
  ], "tool-call/other"),
  group("tool-result", "工具结果", [
    leaf("tool-result/function", "函数结果"), leaf("tool-result/custom", "自定义工具结果"),
    leaf("tool-result/command", "命令结束"), leaf("tool-result/mcp", "MCP 调用结果"), leaf("tool-result/other", "其他工具结果"),
  ], "tool-result/other"),
  group("event", "事件", [
    leaf("event/token-usage", "Token 用量记录"), leaf("event/reasoning", "推理"),
    group("event/lifecycle", "回合与项目", [
      leaf("event/turn-start", "回合开始"), leaf("event/item-completed", "项目完成"),
    ]),
    group("event/context", "上下文", [
      leaf("event/turn-context", "运行上下文"), leaf("event/compacted", "上下文压缩"),
      leaf("event/retained-context", "保留上下文"), leaf("event/world-state", "世界状态"),
    ]),
    group("event/configuration", "配置", [
      leaf("event/thread-settings", "会话设置"), leaf("event/additional-tools", "附加工具"),
    ]),
    leaf("event/communication", "代理间通信"), leaf("event/security", "安全风险评分"),
    leaf("event/realtime", "实时项目"), leaf("event/other", "其他事件"),
  ], "event/other"),
  group("metadata", "会话元数据", [
    leaf("metadata/session-meta", "会话信息"), leaf("metadata/session-meta-entry", "会话信息条目"), leaf("metadata/other", "其他元数据"),
  ], "metadata/other"),
  leaf("invalid", "解析告警"), leaf("empty", "空行"), leaf("oversized", "受限预览"), leaf("other", "其他类型"),
]);

const EVENT_FILTER_TYPES = Object.freeze({
  token_usage_record: "event/token-usage", token_count: "event/token-usage",
  reasoning: "event/reasoning", agent_reasoning: "event/reasoning",
  agent_reasoning_raw_content: "event/reasoning", agent_reasoning_section_break: "event/reasoning",
  task_started: "event/turn-start", turn_started: "event/turn-start",
  item_completed: "event/item-completed",
  turn_context: "event/turn-context", compacted: "event/compacted",
  retained_context: "event/retained-context", world_state: "event/world-state",
  thread_settings_applied: "event/thread-settings", additional_tools: "event/additional-tools",
  inter_agent_communication: "event/communication", security_risk_score: "event/security", realtime_item: "event/realtime",
});

export function filterLeaves(options) {
  return options.flatMap((option) => option.children ? filterLeaves(option.children) : [option]);
}

export function recordFilterType(value, options) {
  for (const option of options) {
    if (option.value === value) return option.children ? option.fallback ?? "other" : option.value;
    if (option.children) {
      const match = recordFilterType(value, option.children);
      if (match !== "other") return match;
    }
  }
  return "other";
}

export function jsonlRecordFilterType(record, kind) {
  const type = record?.type;
  const payload = record?.payload;
  const subtype = type === "response_item" ? payload?.type
    : type === "event_msg" && payload && typeof payload === "object"
      ? payload.type ?? Object.keys(payload)[0]
      : type;
  if (kind === "event") return typeof subtype === "string" && Object.hasOwn(EVENT_FILTER_TYPES, subtype) ? EVENT_FILTER_TYPES[subtype] : "event/other";
  if (kind === "user" || kind === "assistant") {
    if (type === "response_item" && subtype === "message") return `${kind}/message`;
    if (type === "event_msg" && (subtype === "user_message" || subtype === "agent_message")) return `${kind}/event`;
  }
  if (kind === "tool-call") {
    if (subtype === "function_call") return "tool-call/function";
    if (subtype === "custom_tool_call") return "tool-call/custom";
    if (subtype === "exec_command_begin") return "tool-call/command";
    if (subtype === "mcp_tool_call_begin") return "tool-call/mcp";
  }
  if (kind === "tool-result") {
    if (subtype === "function_call_output") return "tool-result/function";
    if (subtype === "custom_tool_call_output") return "tool-result/custom";
    if (subtype === "exec_command_end") return "tool-result/command";
    if (subtype === "mcp_tool_call_end") return "tool-result/mcp";
  }
  if (kind === "metadata") {
    if (type === "session_meta") return "metadata/session-meta";
    if (type === "session_meta_entry") return "metadata/session-meta-entry";
  }
  return recordFilterType(kind, JSONL_RECORD_TYPES);
}
