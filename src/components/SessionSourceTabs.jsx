import { useId, useLayoutEffect, useRef, useState } from "react";
import { browserLogger, createLogId } from "../lib/logger.js";

const SOURCES = [
  { id: "jsonl", label: "JSONL 轨迹" },
  { id: "sqlite", label: "SQLite 历史" },
];

export function SessionSourceTabs({ active = true, tabId, jsonl, sqlite }) {
  const [selectedSource, setSelectedSource] = useState("jsonl");
  const id = useId();
  const savedScrollTops = useRef(new Map());
  const previousSource = useRef(selectedSource);

  function selectSource(source, event) {
    if (source === selectedSource) return;
    const operationId = createLogId();
    browserLogger.log("browser_source", {
      action: "switch",
      data_source: source,
      tab_id: tabId,
      operation_id: operationId,
    }, { operation_id: operationId, tab_id: tabId });
    const scrollPanel = event.currentTarget.closest(".session-tab-panel");
    if (scrollPanel) savedScrollTops.current.set(selectedSource, scrollPanel.scrollTop);
    setSelectedSource(source);
  }

  function onTabKeyDown(event, currentIndex) {
    let nextIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % SOURCES.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex + SOURCES.length - 1) % SOURCES.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SOURCES.length - 1;
    else return;

    event.preventDefault();
    const tabs = [...(event.currentTarget.parentElement?.querySelectorAll('[role="tab"]') ?? [])];
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    selectSource(SOURCES[nextIndex].id, event);
    nextTab.focus();
  }

  useLayoutEffect(() => {
    if (previousSource.current === selectedSource) return;
    previousSource.current = selectedSource;
    const scrollPanel = globalThis.document
      ?.getElementById(`${id}-panel-${selectedSource}`)
      ?.closest(".session-tab-panel");
    if (scrollPanel) scrollPanel.scrollTop = savedScrollTops.current.get(selectedSource) ?? 0;
  }, [id, selectedSource]);

  return (
    <div className="session-source-tabs">
      <div className="session-source-tablist" role="tablist" aria-label="会话数据来源">
        {SOURCES.map((source, index) => {
          const selected = selectedSource === source.id;
          return (
            <button
              type="button"
              role="tab"
              id={`${id}-tab-${source.id}`}
              aria-selected={selected}
              aria-controls={`${id}-panel-${source.id}`}
              tabIndex={selected ? 0 : -1}
              className={selected ? "session-source-tab active" : "session-source-tab"}
              key={source.id}
              onClick={(event) => selectSource(source.id, event)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              {source.label}
            </button>
          );
        })}
      </div>

      <div
        className="session-source-panel"
        id={`${id}-panel-jsonl`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-jsonl`}
        tabIndex={0}
        hidden={selectedSource !== "jsonl"}
      >
        {typeof jsonl === "function" ? jsonl(active && selectedSource === "jsonl") : jsonl}
      </div>
      <div
        className="session-source-panel"
        id={`${id}-panel-sqlite`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-sqlite`}
        tabIndex={0}
        hidden={selectedSource !== "sqlite"}
      >
        {typeof sqlite === "function" ? sqlite(active && selectedSource === "sqlite") : sqlite}
      </div>
    </div>
  );
}
