import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VIRTUAL_ITEM_HEIGHT } from "../lib/virtual-window.js";
import { useVirtualWindow } from "../hooks/useVirtualWindow.js";
import { TimelineEventCard } from "./TimelineEventCard.jsx";

const TIMELINE_OVERSCAN_PX = 520;
const TIMELINE_MAX_MOUNTED_CARDS = 100;

function entryKey(entry) {
  const revision = entry.originalLocator?.revision;
  return revision ? `${revision}:${entry.lineNumber}` : String(entry.lineNumber);
}

function hasEntryText(entry, query) {
  const candidates = [entry.text, ...(entry.contentParts ?? []).map((part) => part.text)];
  for (const value of candidates) {
    if (typeof value === "string" && value.includes(query)) return true;
  }
  return false;
}

const EMPTY_BODY_CURSOR = Object.freeze({ pageIndex: 0, partIndex: 0, fragmentIndex: 0 });
const EMPTY_RAW_OFFSET_HISTORY = Object.freeze([]);
const EMPTY_READING_STATE = Object.freeze({ collapsed: false, rawExpanded: false, bodyCursor: EMPTY_BODY_CURSOR, rawOffset: 0, rawOffsetHistory: EMPTY_RAW_OFFSET_HISTORY });

function defaultReadingState() {
  return { collapsed: false, rawExpanded: false, bodyCursor: EMPTY_BODY_CURSOR, rawOffset: 0, rawOffsetHistory: [] };
}

function timelineMetrics(list, panel) {
  const listRect = list.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const topInViewport = listRect.top - panelRect.top;
  const visibleTop = Math.max(0, -topInViewport);
  const listHeight = list.clientHeight || listRect.height;
  const visibleBottom = Math.max(0, Math.min(listHeight || Number.MAX_SAFE_INTEGER, panelRect.height - topInViewport));
  return {
    scrollTop: visibleTop,
    viewportHeight: Math.max(0, visibleBottom - visibleTop),
  };
}

function TimelineToolbar({
  totalLines,
  currentPage,
  totalPages,
  pageSize,
  startLine,
  pageLoading,
  searchLoading,
  jumpValue,
  onJumpValueChange,
  findQuery,
  onFindQueryChange,
  findStatus,
  onJumpSubmit,
  onFindSubmit,
  onNavigateLine,
}) {
  const toolbarId = useId();
  const ordinalInputId = `timeline-ordinal-${toolbarId}`;
  const findInputId = `timeline-find-${toolbarId}`;

  return (
    <div className="timeline-label timeline-toolbar">
      <div className="timeline-heading">
        <h2>运行记录</h2>
        <span>按 JSONL 物理行顺序 · {totalLines} 行 · 第 {currentPage} / {totalPages} 页</span>
      </div>
      <div className="timeline-navigation" aria-label="时间线导航">
        <button type="button" onClick={() => onNavigateLine(1, "start")} disabled={!totalLines || pageLoading} aria-label="回到会话开始处">↑ 开始</button>
        <button type="button" onClick={() => onNavigateLine(Math.max(1, startLine - pageSize), "start")} disabled={!totalLines || pageLoading || currentPage <= 1} aria-label="上一页">上一页</button>
        <button type="button" onClick={() => onNavigateLine(Math.min(totalLines, startLine + pageSize), "start")} disabled={!totalLines || pageLoading || currentPage >= totalPages} aria-label="下一页">下一页</button>
        <button type="button" onClick={() => onNavigateLine(totalLines, "end")} disabled={!totalLines || pageLoading} aria-label="跳转到会话末尾">↓ 末尾</button>
        <form className="timeline-jump" onSubmit={onJumpSubmit}>
          <label htmlFor={ordinalInputId}>原始行号</label>
          <input id={ordinalInputId} type="number" min="1" max={totalLines} value={jumpValue} onChange={(event) => onJumpValueChange(event.target.value)} aria-label="跳转到原始行号" />
          <button type="submit" disabled={!totalLines || pageLoading}>跳转</button>
        </form>
        <form className="timeline-find" onSubmit={onFindSubmit}>
          <label htmlFor={findInputId}>查找轨迹内容（区分大小写，最多256字符）</label>
          <input id={findInputId} type="search" maxLength="256" value={findQuery} onChange={onFindQueryChange} placeholder="原文文本（区分大小写）" />
          <button type="submit" disabled={!totalLines || pageLoading || searchLoading}>{searchLoading ? "查找中…" : "查找下一个"}</button>
        </form>
        <span className="timeline-navigation-status" role="status" aria-live="polite">{findStatus}</span>
      </div>
    </div>
  );
}

export function Timeline({
  entries,
  rollout,
  currentLine = 1,
  pageLoading = false,
  searchLoading = false,
  sessionId,
  active = true,
  onNavigateLine,
  onSearch,
  onRevisionStale,
}) {
  const entryKeys = useMemo(() => entries.map(entryKey), [entries]);
  const revision = rollout?.revision ?? entries[0]?.originalLocator?.revision ?? "";
  const totalLines = Number.isSafeInteger(rollout?.totalLines) ? rollout.totalLines : entries.length;
  const pageSize = Number.isSafeInteger(rollout?.pageSize) && rollout.pageSize > 0 ? rollout.pageSize : 32;
  const currentPage = totalLines > 0 ? Math.floor(((rollout?.startLine || entries[0]?.lineNumber || 1) - 1) / pageSize) + 1 : 0;
  const totalPages = totalLines > 0 ? Math.ceil(totalLines / pageSize) : 0;
  const timelineRef = useRef(null);
  const observerGenerationRef = useRef(0);
  const readingStateRef = useRef(new Map());
  const readingScopeRef = useRef(revision);
  const focusedEntryRef = useRef(null);
  const pendingFocusRef = useRef(null);
  const pendingNavigationRef = useRef(null);
  const pendingCenterEntryId = useRef(null);
  const findCursorRef = useRef(-1);
  const [readingRevision, setReadingRevision] = useState(0);
  const [visibleEntryIds, setVisibleEntryIds] = useState(() => new Set());
  const [findQuery, setFindQuery] = useState("");
  const [findStatus, setFindStatus] = useState("");
  const [jumpValue, setJumpValue] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const getScrollElement = useCallback(() => timelineRef.current?.closest(".session-tab-panel") ?? null, []);
  const getMetrics = useCallback((list, panel) => timelineMetrics(list, panel), []);
  const virtualWindow = useVirtualWindow({
    itemKeys: entryKeys,
    getScrollElement,
    getMetrics,
    enabled: active,
    estimatedHeight: DEFAULT_VIRTUAL_ITEM_HEIGHT,
    overscanPx: TIMELINE_OVERSCAN_PX,
    maxItems: TIMELINE_MAX_MOUNTED_CARDS,
  });
  const setTimelineRef = useCallback((node) => {
    timelineRef.current = node;
    virtualWindow.listRef.current = node;
  }, [virtualWindow.listRef]);

  useEffect(() => {
    if (readingScopeRef.current !== revision) {
      for (const [lineNumber, state] of readingStateRef.current) {
        if (lineNumber > totalLines) {
          readingStateRef.current.delete(lineNumber);
          continue;
        }
        if (state.rawOffset !== 0 || (state.rawOffsetHistory?.length ?? 0) > 0) {
          readingStateRef.current.set(lineNumber, {
            ...state,
            rawOffset: 0,
            rawOffsetHistory: EMPTY_RAW_OFFSET_HISTORY,
          });
        }
      }
      readingScopeRef.current = revision;
      pendingCenterEntryId.current = null;
      pendingNavigationRef.current = null;
      setReadingRevision((current) => current + 1);
    }
    setVisibleEntryIds((current) => {
      const liveIds = new Set(entryKeys);
      const next = new Set([...current].filter((entryId) => liveIds.has(entryId)));
      return next.size === current.size ? current : next;
    });
  }, [entryKeys, revision]);

  useEffect(() => {
    const timeline = timelineRef.current;
    const panel = getScrollElement();
    const Observer = globalThis.IntersectionObserver;
    if (!active || !timeline || !panel || !Observer) {
      observerGenerationRef.current += 1;
      if (!active) setVisibleEntryIds(new Set());
      return undefined;
    }

    const generation = observerGenerationRef.current + 1;
    observerGenerationRef.current = generation;
    const mountedIds = new Set([...timeline.querySelectorAll(".event-card")].map((card) => card.dataset.eventKey));
    setVisibleEntryIds((current) => {
      const next = new Set([...current].filter((entryId) => mountedIds.has(entryId)));
      return next.size === current.size ? current : next;
    });

    const observer = new Observer((observations) => {
      if (observerGenerationRef.current !== generation) return;
      setVisibleEntryIds((current) => {
        let next = current;
        for (const observation of observations) {
          const eventId = observation.target.dataset.eventKey;
          const visible = observation.isIntersecting && observation.intersectionRatio > 0;
          if (visible === current.has(eventId)) continue;
          if (next === current) next = new Set(current);
          if (visible) next.add(eventId);
          else next.delete(eventId);
        }
        return next;
      });
    }, { root: panel, threshold: 0 });

    timeline.querySelectorAll(".event-card").forEach((card) => observer.observe(card));
    return () => {
      observer.disconnect();
      if (observerGenerationRef.current === generation) observerGenerationRef.current += 1;
    };
  }, [active, entryKeys, getScrollElement, virtualWindow.range.start, virtualWindow.range.end]);

  useLayoutEffect(() => {
    const pendingNavigation = pendingNavigationRef.current;
    if (pendingNavigation) {
      const index = entries.findIndex((entry) => entry.lineNumber === pendingNavigation.lineNumber);
      if (index >= 0) {
        pendingNavigationRef.current = null;
        virtualWindow.scrollToIndex(index, pendingNavigation.align);
        if (pendingNavigation.moveFocus) {
          pendingFocusRef.current = { lineNumber: pendingNavigation.lineNumber };
          setFocusRequest((current) => current + 1);
        }
      }
    }

    const entryId = pendingCenterEntryId.current;
    if (!entryId) return;
    pendingCenterEntryId.current = null;

    const card = [...(timelineRef.current?.querySelectorAll(".event-card") ?? [])]
      .find((candidate) => candidate.dataset.eventKey === entryId);
    const panel = card?.closest(".session-tab-panel");
    if (!card || !panel) return;

    const panelRect = panel.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const viewportHeight = panel.clientHeight || panelRect.height;
    const targetTop = panel.scrollTop + cardRect.top - panelRect.top - (viewportHeight - cardRect.height) / 2;
    const maxScrollTop = Math.max(0, panel.scrollHeight - viewportHeight);
    panel.scrollTo({
      top: Math.max(0, Math.min(targetTop, maxScrollTop)),
      behavior: "smooth",
    });
  }, [entries, readingRevision, virtualWindow.scrollToIndex]);

  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending) {
      pendingFocusRef.current = null;
      const card = [...(timelineRef.current?.querySelectorAll(".event-card") ?? [])]
        .find((candidate) => Number(candidate.dataset.lineNumber) === pending.lineNumber);
      card?.focus();
      return;
    }

    const activeElement = globalThis.document?.activeElement;
    if (activeElement !== globalThis.document?.body) return;
    const focused = focusedEntryRef.current;
    if (!focused) return;
    const focusedIndex = entries.findIndex((entry) => entry.lineNumber === focused.lineNumber);
    if (focusedIndex >= virtualWindow.range.start && focusedIndex < virtualWindow.range.end) return;
    const index = Math.max(virtualWindow.range.start, Math.min(virtualWindow.range.end - 1, focused.index));
    const card = [...(timelineRef.current?.querySelectorAll(".event-card") ?? [])]
      .find((candidate) => Number(candidate.dataset.entryIndex) === index);
    card?.focus();
    if (card) focusedEntryRef.current = { lineNumber: Number(card.dataset.lineNumber), index };
  }, [focusRequest, entries, virtualWindow.range.start, virtualWindow.range.end]);

  const updateReadingState = useCallback((entryId, update) => {
    const current = readingStateRef.current.get(entryId) ?? defaultReadingState();
    const next = update(current);
    const isDefault = !next.collapsed && !next.rawExpanded && next.rawOffset === 0 && next.rawOffsetHistory.length === 0
      && next.bodyCursor.pageIndex === 0 && next.bodyCursor.partIndex === 0 && next.bodyCursor.fragmentIndex === 0;
    if (isDefault) readingStateRef.current.delete(entryId);
    else readingStateRef.current.set(entryId, next);
    setReadingRevision((revision) => revision + 1);
  }, []);

  const toggleCollapse = useCallback((lineNumber, nextCollapsed, body, eventId) => {
    if (nextCollapsed) {
      const card = body?.closest(".event-card");
      const panel = card?.closest(".session-tab-panel");
      const meta = card?.querySelector(".event-meta");
      const panelRect = panel?.getBoundingClientRect();
      const metaRect = meta?.getBoundingClientRect();
      const panelHeight = panel?.clientHeight || panelRect?.height || 0;
      const metaVisible = panelRect && metaRect
        && metaRect.bottom > panelRect.top
        && metaRect.top < panelRect.top + panelHeight;
      pendingCenterEntryId.current = metaVisible ? null : eventId;
    } else {
      pendingCenterEntryId.current = null;
    }
    updateReadingState(lineNumber, (current) => ({
      ...current,
      collapsed: nextCollapsed,
      rawExpanded: nextCollapsed ? false : current.rawExpanded,
    }));
  }, [updateReadingState]);

  const setRawExpanded = useCallback((entryId, rawExpanded) => {
    updateReadingState(entryId, (current) => ({ ...current, rawExpanded }));
  }, [updateReadingState]);

  const setRawOffset = useCallback((entryId, offset, direction = "push") => {
    if (!Number.isSafeInteger(offset) || offset < 0) return;
    updateReadingState(entryId, (current) => {
      const history = [...(current.rawOffsetHistory ?? [])];
      if (direction === "back") history.pop();
      else history.push(current.rawOffset ?? 0);
      return { ...current, rawOffset: offset, rawOffsetHistory: history.slice(-64) };
    });
  }, [updateReadingState]);

  const setBodyCursor = useCallback((entryId, bodyCursor) => {
    updateReadingState(entryId, (current) => ({ ...current, bodyCursor }));
  }, [updateReadingState]);

  const navigateLine = useCallback((lineNumber, align = "start", moveFocus = false) => {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > totalLines) return;
    const index = entries.findIndex((entry) => entry.lineNumber === lineNumber);
    if (index >= 0) {
      if (moveFocus) {
        pendingFocusRef.current = { lineNumber };
        setFocusRequest((current) => current + 1);
      }
      virtualWindow.scrollToIndex(index, align);
      return;
    }
    pendingNavigationRef.current = { lineNumber, align, moveFocus };
    if (onNavigateLine) void onNavigateLine(lineNumber);
  }, [entries, onNavigateLine, totalLines, virtualWindow.scrollToIndex]);

  const scrollToEntry = useCallback((event, edge) => {
    const lineNumber = edge === "first" ? 1 : totalLines;
    navigateLine(lineNumber, edge === "first" ? "start" : "end", true);
  }, [navigateLine, totalLines]);

  async function findNext(event) {
    event?.preventDefault();
    const submittedQuery = event?.currentTarget?.querySelector("input")?.value ?? findQuery;
    setFindQuery(submittedQuery);
    const query = submittedQuery;
    if (!query) {
      setFindStatus("请输入要查找的文本");
      return;
    }
    if (query.length > 256) {
      setFindStatus("查找文本最多 256 个 UTF-16 代码单元");
      return;
    }
    const afterLine = currentLine > 0 ? currentLine : 0;
    const lineNumber = onSearch
      ? await onSearch(query, afterLine)
      : entries.find((entry) => hasEntryText(entry, query))?.lineNumber ?? null;
    if (lineNumber === undefined) return;
    if (lineNumber == null) setFindStatus("未找到匹配记录（区分大小写）");
    else {
      setFindStatus(`第 ${lineNumber} / ${totalLines} 行（区分大小写）`);
      navigateLine(lineNumber, "center");
    }
  }

  function jumpToOrdinal(event) {
    event?.preventDefault();
    const submittedOrdinal = event?.currentTarget?.querySelector("input")?.value ?? jumpValue;
    setJumpValue(submittedOrdinal);
    const lineNumber = Number(submittedOrdinal);
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > totalLines) {
      setFindStatus(`请输入 1 到 ${totalLines} 之间的原始行号`);
      return;
    }
    setFindStatus(`第 ${lineNumber} / ${totalLines} 行`);
    navigateLine(lineNumber, "start");
  }

  function onTimelineKeyDown(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.target.closest("input, textarea, select, a, [contenteditable='true']")) return;
    const card = event.target.closest(".event-card");
    if (!card) return;
    event.preventDefault();
    const currentLineNumber = Number(card.dataset.lineNumber);
    const nextLine = Math.max(1, Math.min(totalLines, currentLineNumber + (event.key === "ArrowDown" ? 1 : -1)));
    if (nextLine === currentLineNumber) return;
    navigateLine(nextLine, "center", true);
  }

  function onTimelineFocus(event) {
    const card = event.target.closest(".event-card");
    if (card) focusedEntryRef.current = { lineNumber: Number(card.dataset.lineNumber), index: Number(card.dataset.entryIndex) };
  }

  const start = Math.min(virtualWindow.range.start, entries.length);
  const end = Math.min(virtualWindow.range.end, entries.length);
  const mountedEntries = entries.slice(start, end);
  const layout = virtualWindow.layout;
  const toolbarProps = {
    totalLines,
    currentPage,
    totalPages,
    pageSize,
    startLine: rollout?.startLine ?? 1,
    pageLoading,
    searchLoading,
    jumpValue,
    onJumpValueChange: setJumpValue,
    findQuery,
    onFindQueryChange: (event) => {
      setFindQuery(event.target.value);
      setFindStatus("");
      findCursorRef.current = -1;
    },
    findStatus,
    onJumpSubmit: jumpToOrdinal,
    onFindSubmit: findNext,
    onNavigateLine: navigateLine,
  };

  return (
    <>
      <TimelineToolbar {...toolbarProps} />
      {pageLoading && <p className="timeline-load-status" role="status">正在读取第 {currentLine || 1} 行所在页…</p>}
      <div
        className="timeline virtual-timeline"
        ref={setTimelineRef}
        role="list"
        aria-label="运行记录时间线"
        aria-setsize={totalLines}
        tabIndex={-1}
        onKeyDown={onTimelineKeyDown}
        onFocusCapture={onTimelineFocus}
      >
        <div className="timeline-virtual-spacer" role="presentation" aria-hidden="true" style={{ height: virtualWindow.range.offsetTop }} />
        {mountedEntries.map((entry, offset) => {
              const index = start + offset;
              const eventId = entryKeys[index];
              const savedReadingState = readingStateRef.current.get(entry.lineNumber) ?? EMPTY_READING_STATE;
              const readingState = readingScopeRef.current === revision
                ? savedReadingState
                : { ...savedReadingState, rawOffset: 0, rawOffsetHistory: EMPTY_RAW_OFFSET_HISTORY };
              const rawOffsetHistory = readingState.rawOffsetHistory ?? EMPTY_RAW_OFFSET_HISTORY;
              return (
                <TimelineEventCard
                  key={eventId}
                  entry={entry}
                  entryId={eventId}
                  readingKey={entry.lineNumber}
                  entryIndex={index}
                  lineIndex={entry.lineNumber - 1}
                  totalEntries={totalLines}
                  sessionId={sessionId}
                  active={active}
                  isLast={entry.lineNumber === totalLines}
                  collapsed={readingState.collapsed}
                  rawExpanded={readingState.rawExpanded}
                  bodyCursor={readingState.bodyCursor}
                  rawOffset={readingState.rawOffset}
                  rawOffsetHistory={rawOffsetHistory}
                  controlsVisible={active && (globalThis.IntersectionObserver ? visibleEntryIds.has(eventId) : true)}
                  registerItem={virtualWindow.registerItem}
                  onToggleCollapse={toggleCollapse}
                  onRawExpandedChange={setRawExpanded}
                  onBodyCursorChange={setBodyCursor}
                  onRawOffsetChange={setRawOffset}
                  onScrollToEntry={scrollToEntry}
                  onRevisionStale={onRevisionStale}
                />
              );
        })}
        <div className="timeline-virtual-spacer" role="presentation" aria-hidden="true" style={{ height: virtualWindow.range.offsetBottom }} />
      </div>
      <TimelineToolbar {...toolbarProps} />
    </>
  );
}
