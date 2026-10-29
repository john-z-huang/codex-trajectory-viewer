import test from "node:test";
import assert from "node:assert/strict";
import {
  createRolloutPageCache,
  ROLLOUT_PAGE_CACHE_MAX_BYTES,
  ROLLOUT_PAGE_CACHE_MAX_PAGES,
} from "../src/lib/rollout-page-cache.js";

test("rollout page cache defaults to four pages and four MiB per instance", () => {
  const first = createRolloutPageCache();
  const second = createRolloutPageCache();

  assert.deepEqual(first.diagnostics(), {
    pageCount: 0,
    logicalBytes: 0,
    maxPages: 4,
    maxBytes: 4 * 1024 * 1024,
  });
  assert.equal(ROLLOUT_PAGE_CACHE_MAX_PAGES, 4);
  assert.equal(ROLLOUT_PAGE_CACHE_MAX_BYTES, 4 * 1024 * 1024);

  assert.equal(first.set("rev-1", 1, [{ text: "alpha" }]), true);
  assert.equal(first.get("rev-1", 1)[0].text, "alpha");
  assert.equal(second.get("rev-1", 1), undefined);
});

test("cache counts serialized UTF-8 bytes, updates LRU order and evicts by page count", () => {
  const cache = createRolloutPageCache({ maxPages: 2, maxBytes: 1024 });
  const first = [{ text: "中文😀" }];
  const firstBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;

  assert.equal(cache.set("rev", 1, first), true);
  assert.equal(cache.diagnostics().logicalBytes, firstBytes);
  assert.deepEqual(cache.get("rev", 1), first);
  assert.equal(cache.set("rev", 33, [{ text: "second" }]), true);
  assert.equal(cache.get("rev", 1)?.[0].text, "中文😀"); // Touch page 1, making page 33 least recently used.
  assert.equal(cache.set("rev", 65, [{ text: "third" }]), true);

  assert.notEqual(cache.get("rev", 1), undefined);
  assert.equal(cache.get("rev", 33), undefined);
  assert.notEqual(cache.get("rev", 65), undefined);
  assert.equal(cache.set("rev", 33, [{ text: "second page reread" }]), true);
  assert.equal(cache.get("rev", 33)[0].text, "second page reread");
  assert.equal(cache.diagnostics().pageCount, 2);
  assert.ok(cache.diagnostics().logicalBytes <= cache.diagnostics().maxBytes);
});

test("cache enforces the byte budget and rejects oversized or invalid pages", () => {
  const cache = createRolloutPageCache({ maxPages: 4, maxBytes: 80 });
  assert.equal(cache.set("rev", 1, [{ text: "a".repeat(60) }]), true);
  assert.equal(cache.set("rev", 33, [{ text: "b".repeat(40) }]), true);
  assert.equal(cache.get("rev", 1), undefined);
  assert.ok(cache.diagnostics().logicalBytes <= 80);

  const before = cache.diagnostics();
  assert.equal(cache.set("rev", 65, [{ text: "x".repeat(200) }]), false);
  assert.equal(cache.set("rev", 97, undefined), false);
  assert.equal(cache.diagnostics().pageCount, before.pageCount);
  assert.equal(cache.diagnostics().logicalBytes, before.logicalBytes);

  assert.equal(cache.set("rev", 1, [{ text: "fresh" }]), true);
  assert.equal(cache.set("rev", 1, [{ text: "x".repeat(200) }]), false);
  assert.equal(cache.get("rev", 1), undefined); // An oversized replacement cannot leave stale data under the same key.
});

test("clear by revision and clear all release cached pages", () => {
  const cache = createRolloutPageCache();
  cache.set("rev-a", 1, [{ lineNumber: 1 }]);
  cache.set("rev-b", 1, [{ lineNumber: 1 }]);

  cache.clear("rev-a");
  assert.equal(cache.get("rev-a", 1), undefined);
  assert.notEqual(cache.get("rev-b", 1), undefined);
  assert.equal(cache.diagnostics().pageCount, 1);

  cache.clear();
  assert.deepEqual(cache.diagnostics(), {
    pageCount: 0,
    logicalBytes: 0,
    maxPages: 4,
    maxBytes: 4 * 1024 * 1024,
  });
});

test("cached projections are immutable to keep their byte accounting stable", () => {
  const cache = createRolloutPageCache();
  assert.equal(cache.set("rev", 1, [{ text: "frozen" }]), true);
  const page = cache.get("rev", 1);

  assert.throws(() => { page[0].text = "mutated"; }, TypeError);
  assert.equal(cache.get("rev", 1)[0].text, "frozen");
});
