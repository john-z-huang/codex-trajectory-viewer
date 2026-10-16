export function formatDate(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function agentStatusLabel(status) {
  return ({ started: "已启动", interacted: "执行中", interrupted: "已中断", completed: "已完成" })[status] ?? "状态未知";
}
