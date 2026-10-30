export const initialWorkspace = { tabs: [], activeId: null, notice: "" };

export function workspaceReducer(state, action) {
  if (action.type === "open") {
    if (state.tabs.some((file) => file.id === action.file.id)) return { ...state, activeId: action.file.id, notice: "" };
    if (state.tabs.length >= 8) return { ...state, notice: "最多同时打开 8 个文件，请先关闭一个标签。" };
    return { tabs: [...state.tabs, action.file], activeId: action.file.id, notice: "" };
  }
  if (action.type === "activate") return state.tabs.some((file) => file.id === action.id) ? { ...state, activeId: action.id } : state;
  if (action.type === "close") {
    const index = state.tabs.findIndex((file) => file.id === action.id);
    if (index < 0) return state;
    const tabs = state.tabs.filter((file) => file.id !== action.id);
    return { tabs, activeId: state.activeId === action.id ? tabs[Math.max(0, index - 1)]?.id ?? null : state.activeId, notice: "" };
  }
  return state;
}
