export const DEFAULT_VIRTUAL_ITEM_HEIGHT = 176;
export const DEFAULT_MAX_MEASUREMENTS = 2048;
export const DEFAULT_VIRTUAL_WINDOW_ITEMS = 100;

const CORRECTION_BLOCK_SIZE = 64;

function finitePositive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedIndex(index, count) {
  return Math.max(0, Math.min(count, Math.trunc(index) || 0));
}

export function createVirtualLayout({
  itemKeys = [],
  estimatedHeight = DEFAULT_VIRTUAL_ITEM_HEIGHT,
  maxMeasurements = DEFAULT_MAX_MEASUREMENTS,
} = {}) {
  const estimate = finitePositive(estimatedHeight, DEFAULT_VIRTUAL_ITEM_HEIGHT);
  const measurementLimit = Math.max(0, Math.trunc(maxMeasurements) || 0);
  let keys = [];
  let blockCount = 0;
  let fenwick = new Float64Array(1);
  let correctionsByBlock = new Map();
  const measurements = new Map();

  function fenwickAdd(blockIndex, delta) {
    for (let cursor = blockIndex + 1; cursor < fenwick.length; cursor += cursor & -cursor) {
      fenwick[cursor] += delta;
    }
  }

  function fenwickPrefix(blockEnd) {
    let sum = 0;
    for (let cursor = blockEnd; cursor > 0; cursor -= cursor & -cursor) sum += fenwick[cursor];
    return sum;
  }

  function changeCorrection(index, delta) {
    if (!delta || index < 0 || index >= keys.length) return;
    const blockIndex = Math.floor(index / CORRECTION_BLOCK_SIZE);
    let block = correctionsByBlock.get(blockIndex);
    if (!block) {
      block = new Map();
      correctionsByBlock.set(blockIndex, block);
    }
    const next = (block.get(index) ?? 0) + delta;
    if (Math.abs(next) < 0.01) block.delete(index);
    else block.set(index, next);
    if (block.size === 0) correctionsByBlock.delete(blockIndex);
    fenwickAdd(blockIndex, delta);
  }

  function rebuildCorrections() {
    blockCount = Math.ceil(keys.length / CORRECTION_BLOCK_SIZE);
    fenwick = new Float64Array(blockCount + 1);
    correctionsByBlock = new Map();
    for (const [key, measurement] of measurements) {
      const index = measurement.index;
      if (index < 0 || index >= keys.length || keys[index] !== key) continue;
      const delta = measurement.height - estimate;
      changeCorrection(index, delta);
    }
  }

  function setItems(nextKeys) {
    const normalized = Array.isArray(nextKeys) ? nextKeys : [];
    if (normalized === keys) return false;

    const nextIndexByKey = new Map();
    for (let index = 0; index < normalized.length; index += 1) nextIndexByKey.set(normalized[index], index);

    for (const [key, measurement] of measurements) {
      const index = nextIndexByKey.get(key);
      if (index == null) measurements.delete(key);
      else measurement.index = index;
    }
    keys = normalized;
    rebuildCorrections();
    return true;
  }

  function offsetForIndex(index) {
    const end = boundedIndex(index, keys.length);
    const fullBlocks = Math.floor(end / CORRECTION_BLOCK_SIZE);
    const partialItems = end % CORRECTION_BLOCK_SIZE;
    let correction = fenwickPrefix(fullBlocks);
    if (partialItems) {
      const block = correctionsByBlock.get(fullBlocks);
      if (block) {
        const partialEnd = fullBlocks * CORRECTION_BLOCK_SIZE + partialItems;
        for (const [itemIndex, delta] of block) {
          if (itemIndex < partialEnd) correction += delta;
        }
      }
    }
    return end * estimate + correction;
  }

  function findIndexAt(offset) {
    if (!keys.length) return 0;
    const target = Math.max(0, Number.isFinite(offset) ? offset : 0);
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsetForIndex(middle + 1) <= target) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, keys.length - 1);
  }

  function measure(key, rawHeight, indexHint) {
    const height = finitePositive(rawHeight, 0);
    if (!height || measurementLimit === 0) return false;
    const hintedIndex = Number.isInteger(indexHint) ? indexHint : -1;
    const index = hintedIndex >= 0 && keys[hintedIndex] === key ? hintedIndex : keys.indexOf(key);
    if (index < 0) return false;

    const previous = measurements.get(key);
    if (previous && Math.abs(previous.height - height) < 0.5) {
      measurements.delete(key);
      measurements.set(key, previous);
      return false;
    }

    if (previous) changeCorrection(previous.index, estimate - previous.height);
    changeCorrection(index, height - estimate);
    measurements.delete(key);
    measurements.set(key, { index, height });

    while (measurements.size > measurementLimit) {
      const oldestKey = measurements.keys().next().value;
      const oldest = measurements.get(oldestKey);
      if (oldest) changeCorrection(oldest.index, estimate - oldest.height);
      measurements.delete(oldestKey);
    }
    return true;
  }

  function anchorAt(offset) {
    if (!keys.length) return null;
    const index = findIndexAt(offset);
    return { key: keys[index], index, offsetWithinItem: Math.max(0, offset - offsetForIndex(index)) };
  }

  function indexOfKey(key) {
    const measurement = measurements.get(key);
    if (measurement && keys[measurement.index] === key) return measurement.index;
    return keys.indexOf(key);
  }

  setItems(itemKeys);

  return {
    get count() { return keys.length; },
    get measuredCount() { return measurements.size; },
    get totalHeight() { return offsetForIndex(keys.length); },
    estimatedHeight: estimate,
    offsetForIndex,
    findIndexAt,
    anchorAt,
    indexOfKey,
    measure,
    setItems,
  };
}

export function calculateVirtualRange(layout, {
  scrollTop = 0,
  viewportHeight = 720,
  overscanPx = 360,
  maxItems = DEFAULT_VIRTUAL_WINDOW_ITEMS,
} = {}) {
  const count = layout?.count ?? 0;
  if (!count) return { start: 0, end: 0, offsetTop: 0, offsetBottom: 0, totalHeight: 0 };

  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const viewport = finitePositive(viewportHeight, 720);
  const overscan = Math.max(0, Number.isFinite(overscanPx) ? overscanPx : 360);
  const limit = Math.max(1, Math.trunc(maxItems) || DEFAULT_VIRTUAL_WINDOW_ITEMS);
  const visibleStart = layout.findIndexAt(top);
  const visibleEnd = Math.min(count, layout.findIndexAt(top + viewport) + 1);

  let start = layout.findIndexAt(Math.max(0, top - overscan));
  let end = Math.min(count, layout.findIndexAt(top + viewport + overscan) + 1);
  if (end - start > limit) {
    const visibleCount = visibleEnd - visibleStart;
    if (visibleCount >= limit) {
      start = visibleStart;
      end = Math.min(count, start + limit);
    } else {
      const spare = limit - visibleCount;
      start = Math.max(0, visibleStart - Math.floor(spare / 2));
      end = Math.min(count, start + limit);
      start = Math.max(0, end - limit);
    }
  }

  const offsetTop = layout.offsetForIndex(start);
  const offsetBottom = Math.max(0, layout.totalHeight - layout.offsetForIndex(end));
  return { start, end, offsetTop, offsetBottom, totalHeight: layout.totalHeight };
}
