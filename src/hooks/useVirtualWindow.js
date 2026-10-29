import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  calculateVirtualRange,
  createVirtualLayout,
  DEFAULT_VIRTUAL_ITEM_HEIGHT,
  DEFAULT_VIRTUAL_WINDOW_ITEMS,
} from "../lib/virtual-window.js";

const DEFAULT_VIEWPORT_HEIGHT = 720;

function finiteViewport(value, fallback = DEFAULT_VIEWPORT_HEIGHT) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sameRange(left, right) {
  return left.start === right.start
    && left.end === right.end
    && left.offsetTop === right.offsetTop
    && left.offsetBottom === right.offsetBottom
    && left.totalHeight === right.totalHeight;
}

function requestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") return globalThis.requestAnimationFrame(callback);
  return globalThis.setTimeout(callback, 16);
}

function cancelFrame(frame) {
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(frame);
  else globalThis.clearTimeout(frame);
}

export function useVirtualWindow({
  itemKeys,
  getScrollElement,
  getMetrics,
  enabled = true,
  estimatedHeight = DEFAULT_VIRTUAL_ITEM_HEIGHT,
  overscanPx = 360,
  maxItems = DEFAULT_VIRTUAL_WINDOW_ITEMS,
}) {
  const listRef = useRef(null);
  const layoutRef = useRef(null);
  if (!layoutRef.current) {
    layoutRef.current = createVirtualLayout({ itemKeys, estimatedHeight });
  }
  const nodesRef = useRef(new Map());
  const observerRef = useRef(null);
  const anchorRef = useRef(null);
  const previousKeysRef = useRef(itemKeys);
  const [range, setRange] = useState(() => calculateVirtualRange(layoutRef.current, {
    scrollTop: 0,
    viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
    overscanPx,
    maxItems,
  }));

  const readMetrics = useCallback(() => {
    const list = listRef.current;
    const scrollElement = getScrollElement?.();
    if (getMetrics && list && scrollElement) {
      const metrics = getMetrics(list, scrollElement) ?? {};
      return {
        scrollTop: Math.max(0, Number.isFinite(metrics.scrollTop) ? metrics.scrollTop : 0),
        viewportHeight: finiteViewport(metrics.viewportHeight),
      };
    }
    return {
      scrollTop: Math.max(0, Number.isFinite(scrollElement?.scrollTop) ? scrollElement.scrollTop : 0),
      viewportHeight: finiteViewport(scrollElement?.clientHeight),
    };
  }, [getMetrics, getScrollElement]);

  const refreshWindow = useCallback((scrollTop = readMetrics().scrollTop, viewportHeight = readMetrics().viewportHeight) => {
    const next = calculateVirtualRange(layoutRef.current, {
      scrollTop,
      viewportHeight,
      overscanPx,
      maxItems,
    });
    setRange((current) => sameRange(current, next) ? current : next);
    const anchor = layoutRef.current.anchorAt(scrollTop);
    if (anchor) anchorRef.current = anchor;
  }, [maxItems, overscanPx, readMetrics]);

  const registerItem = useCallback((key, node) => {
    const previous = nodesRef.current.get(key);
    if (previous === node) return;
    if (previous) observerRef.current?.unobserve(previous);
    if (!node) {
      nodesRef.current.delete(key);
      return;
    }
    nodesRef.current.set(key, node);
    observerRef.current?.observe(node);
  }, []);

  const preserveAnchorAfterMeasurements = useCallback((beforeScrollTop, anchor) => {
    if (!anchor) return;
    const layout = layoutRef.current;
    let index = anchor.index;
    if (layout.count <= index || itemKeys?.[index] !== anchor.key) index = layout.indexOfKey(anchor.key);
    if (index < 0) return;
    const nextScrollTop = layout.offsetForIndex(index) + anchor.offsetWithinItem;
    const scrollElement = getScrollElement?.();
    if (scrollElement && Math.abs(nextScrollTop - beforeScrollTop) >= 0.5) {
      scrollElement.scrollTop += nextScrollTop - beforeScrollTop;
    }
    anchorRef.current = { key: anchor.key, index, offsetWithinItem: anchor.offsetWithinItem };
  }, [getScrollElement, itemKeys]);

  useLayoutEffect(() => {
    if (previousKeysRef.current === itemKeys) return;
    previousKeysRef.current = itemKeys;
    const layout = layoutRef.current;
    const anchor = anchorRef.current;
    layout.setItems(itemKeys);

    let scrollTop = readMetrics().scrollTop;
    if (anchor) {
      const index = layout.indexOfKey(anchor.key);
      if (index >= 0) {
        scrollTop = layout.offsetForIndex(index) + anchor.offsetWithinItem;
        anchorRef.current = { ...anchor, index };
        const scrollElement = enabled ? getScrollElement?.() : null;
        if (scrollElement) {
          const previous = readMetrics().scrollTop;
          scrollElement.scrollTop += scrollTop - previous;
        }
      } else {
        anchorRef.current = null;
      }
    }
    refreshWindow(scrollTop);
  }, [enabled, getScrollElement, itemKeys, readMetrics, refreshWindow]);

  useLayoutEffect(() => {
    if (!enabled || !listRef.current) return undefined;
    const list = listRef.current;
    const scrollElement = getScrollElement?.();
    if (!scrollElement) return undefined;

    let frame = 0;
    let disposed = false;
    const layout = layoutRef.current;

    function measureNodes(observations = []) {
      if (disposed) return;
      const metrics = readMetrics();
      const anchor = layout.anchorAt(metrics.scrollTop);
      let changed = false;

      if (observations.length) {
        for (const observation of observations) {
          const node = observation.target;
          const key = node.dataset.virtualKey;
          const index = Number(node.dataset.virtualIndex);
          const measured = observation.borderBoxSize?.[0]?.blockSize
            ?? observation.contentRect?.height
            ?? node.getBoundingClientRect?.().height;
          changed = layout.measure(key, measured, index) || changed;
        }
      } else {
        for (const [key, node] of nodesRef.current) {
          changed = layout.measure(key, node.getBoundingClientRect?.().height, Number(node.dataset.virtualIndex)) || changed;
        }
      }

      if (changed) preserveAnchorAfterMeasurements(metrics.scrollTop, anchor);
      refreshWindow(readMetrics().scrollTop, readMetrics().viewportHeight);
    }

    const Observer = globalThis.ResizeObserver;
    const observer = Observer ? new Observer((observations) => measureNodes(observations)) : null;
    observerRef.current = observer;
    if (observer) {
      observer.observe(list);
      observer.observe(scrollElement);
      for (const node of nodesRef.current.values()) observer.observe(node);
      measureNodes();
    }

    function scheduleRefresh() {
      if (frame) return;
      frame = requestFrame(() => {
        frame = 0;
        if (observer) refreshWindow();
        else measureNodes();
      });
    }

    scrollElement.addEventListener("scroll", scheduleRefresh, { passive: true });
    globalThis.addEventListener?.("resize", scheduleRefresh, { passive: true });
    scheduleRefresh();

    return () => {
      disposed = true;
      if (frame) cancelFrame(frame);
      scrollElement.removeEventListener("scroll", scheduleRefresh);
      globalThis.removeEventListener?.("resize", scheduleRefresh);
      observer?.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [enabled, getScrollElement, itemKeys, preserveAnchorAfterMeasurements, readMetrics, refreshWindow]);

  const scrollToIndex = useCallback((rawIndex, align = "start") => {
    const layout = layoutRef.current;
    if (!layout.count) return;
    const index = Math.max(0, Math.min(layout.count - 1, Math.trunc(rawIndex) || 0));
    const metrics = readMetrics();
    const top = layout.offsetForIndex(index);
    const bottom = layout.offsetForIndex(index + 1);
    let target = top;
    if (align === "center") target = top - Math.max(0, (metrics.viewportHeight - (bottom - top)) / 2);
    if (align === "end") target = bottom - metrics.viewportHeight;
    const nextTop = Math.max(0, target);
    const scrollElement = getScrollElement?.();
    if (scrollElement) scrollElement.scrollTop += nextTop - metrics.scrollTop;
    anchorRef.current = { key: itemKeys[index], index, offsetWithinItem: Math.max(0, nextTop - top) };
    refreshWindow(nextTop, metrics.viewportHeight);
  }, [getScrollElement, itemKeys, readMetrics, refreshWindow]);

  const scrollToTop = useCallback(() => {
    const metrics = readMetrics();
    const scrollElement = getScrollElement?.();
    if (scrollElement) scrollElement.scrollTop -= metrics.scrollTop;
    anchorRef.current = layoutRef.current.anchorAt(0);
    refreshWindow(0, metrics.viewportHeight);
  }, [getScrollElement, readMetrics, refreshWindow]);

  return {
    listRef,
    range,
    layout: layoutRef.current,
    registerItem,
    refreshWindow,
    scrollToIndex,
    scrollToTop,
  };
}
