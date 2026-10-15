export function createEmptySessionTabs() {
  return { tabs: [], activeTabId: null };
}

export function sessionTabsReducer(state, action) {
  switch (action.type) {
    case "open": {
      if (!action.sessionId || !action.id || state.tabs.some((tab) => tab.id === action.id)) return state;
      const tab = { id: action.id, sessionId: action.sessionId };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id };
    }
    case "activate":
      return state.tabs.some((tab) => tab.id === action.id)
        ? { ...state, activeTabId: action.id }
        : state;
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      const activeTabId = state.activeTabId === action.id
        ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null
        : state.activeTabId;
      return { tabs, activeTabId };
    }
    default:
      return state;
  }
}
