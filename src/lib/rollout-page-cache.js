const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function cacheKey(revision, startLine) {
  if ((typeof revision !== "string" && typeof revision !== "number") || !Number.isSafeInteger(startLine) || startLine < 0) return null;
  return JSON.stringify([revision, startLine]);
}

function freezeJsonTree(root) {
  const pending = [root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || Object.isFrozen(value)) continue;
    for (const child of Object.values(value)) pending.push(child);
    Object.freeze(value);
  }
  return root;
}

/** Create an isolated LRU for lightweight, already-projected rollout pages. */
export function createRolloutPageCache({ maxPages = DEFAULT_MAX_PAGES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const pageLimit = positiveLimit(maxPages, DEFAULT_MAX_PAGES);
  const byteLimit = positiveLimit(maxBytes, DEFAULT_MAX_BYTES);
  const pages = new Map();
  let logicalBytes = 0;

  function remove(key) {
    const existing = pages.get(key);
    if (!existing) return false;
    pages.delete(key);
    logicalBytes -= existing.bytes;
    return true;
  }

  function get(revision, startLine) {
    const key = cacheKey(revision, startLine);
    if (key === null || !pages.has(key)) return undefined;
    const entry = pages.get(key);
    pages.delete(key);
    pages.set(key, entry);
    return entry.value;
  }

  function set(revision, startLine, page) {
    const key = cacheKey(revision, startLine);
    if (key === null) return false;
    // A rejected replacement must not leave an older value for the same key.
    remove(key);

    let serialized;
    try {
      serialized = JSON.stringify(page);
    } catch {
      return false;
    }
    if (typeof serialized !== "string") return false;

    const bytes = encoder.encode(serialized).byteLength;
    if (bytes > byteLimit || pageLimit === 0 || byteLimit === 0) return false;

    let value;
    try {
      value = freezeJsonTree(JSON.parse(serialized));
    } catch {
      return false;
    }

    while (pages.size >= pageLimit || logicalBytes + bytes > byteLimit) {
      const oldestKey = pages.keys().next().value;
      if (oldestKey === undefined) break;
      remove(oldestKey);
    }

    pages.set(key, { revision, startLine, value, bytes });
    logicalBytes += bytes;
    return true;
  }

  function clear(revision) {
    if (revision === undefined) {
      pages.clear();
      logicalBytes = 0;
      return;
    }
    for (const [key, entry] of pages) {
      if (entry.revision === revision) remove(key);
    }
  }

  function diagnostics() {
    return {
      pageCount: pages.size,
      logicalBytes,
      maxPages: pageLimit,
      maxBytes: byteLimit,
    };
  }

  return { get, set, clear, diagnostics };
}

export { DEFAULT_MAX_PAGES as ROLLOUT_PAGE_CACHE_MAX_PAGES, DEFAULT_MAX_BYTES as ROLLOUT_PAGE_CACHE_MAX_BYTES };
