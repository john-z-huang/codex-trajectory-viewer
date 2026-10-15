import { mcpToolResultParts, toolOutputParts } from "./markdown-content.js";

const textFrom = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.text ?? item?.content ?? "").filter(Boolean).join("\n");
  return "";
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
    return { kind: "event", title: item.type ?? "response_item", text: "" };
  }
  if (type === "event_msg") {
    const event = typeof payload === "object" ? payload.type ?? Object.keys(payload)[0] : "";
    const detail = payload?.type ? payload : payload?.[event] ?? {};
    if (event === "user_message") return { kind: "user", title: "用户消息", text: textFrom(detail.message ?? detail.content), markdown: true };
    if (event === "agent_message") return { kind: "assistant", title: "助手消息", text: textFrom(detail.message ?? detail.content), markdown: true };
    if (event === "exec_command_begin" || event === "mcp_tool_call_begin") return { kind: "tool-call", title: detail.command ?? detail.tool ?? event, text: JSON.stringify(detail, null, 2) };
    if (event === "mcp_tool_call_end") return { kind: "tool-result", title: `${detail.tool ?? detail.invocation?.name ?? event} · 结果`, contentParts: mcpToolResultParts(detail.result), text: JSON.stringify(detail, null, 2) };
    if (event === "exec_command_end") return { kind: "tool-result", title: `${detail.command ?? event} · 结果`, text: JSON.stringify(detail, null, 2) };
    return { kind: "event", title: event || type, text: "" };
  }
  if (type === "turn_context") return { kind: "event", title: "运行上下文", text: "" };
  return { kind: "event", title: type, text: "" };
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
