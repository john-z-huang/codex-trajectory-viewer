import assert from "node:assert/strict";
import test from "node:test";
import { calculateVirtualRange, createVirtualLayout } from "../src/lib/virtual-window.js";

test("virtual layout caps mounted windows for 1k, 10k, and 50k items", () => {
  for (const count of [1_000, 10_000, 50_000]) {
    const keys = Array.from({ length: count }, (_, index) => `entry-${index}`);
    const layout = createVirtualLayout({ itemKeys: keys, estimatedHeight: 180 });
    for (const scrollTop of [0, layout.totalHeight / 2, layout.totalHeight]) {
      const range = calculateVirtualRange(layout, {
        scrollTop,
        viewportHeight: 720,
        overscanPx: 520,
        maxItems: 100,
      });
      assert.ok(range.end > range.start);
      assert.ok(range.end - range.start <= 100);
      assert.ok(Number.isFinite(range.offsetTop));
      assert.ok(Number.isFinite(range.offsetBottom));
    }
  }
});

test("sparse dynamic-height corrections locate items and preserve a stable anchor", () => {
  const keys = Array.from({ length: 100 }, (_, index) => `entry-${index}`);
  const layout = createVirtualLayout({ itemKeys: keys, estimatedHeight: 100 });
  assert.equal(layout.measure("entry-0", 160, 0), true);
  assert.equal(layout.measure("entry-4", 70, 4), true);
  assert.equal(layout.offsetForIndex(5), 530);
  assert.equal(layout.findIndexAt(460), 4);

  const anchor = layout.anchorAt(485);
  assert.deepEqual(anchor, { key: "entry-4", index: 4, offsetWithinItem: 25 });
  layout.measure("entry-0", 200, 0);
  const nextTop = layout.offsetForIndex(layout.indexOfKey(anchor.key)) + anchor.offsetWithinItem;
  assert.equal(nextTop, 525);
});

test("project group boundary padding accumulates in offsets across multiple groups", () => {
  const keys = [
    "project:one", "session:one-first", "session:one-last",
    "project:two", "session:two-first", "session:two-last",
    "project:three", "session:three-first", "session:three-last",
  ];
  const borderBoxHeights = [42, 86, 100, 42, 86, 100, 42, 86, 100];
  const layout = createVirtualLayout({ itemKeys: keys, estimatedHeight: 64 });

  keys.forEach((key, index) => layout.measure(key, borderBoxHeights[index], index));

  assert.equal(layout.offsetForIndex(3), 228, "the next project begins after the padded final session row");
  assert.equal(layout.offsetForIndex(6), 456, "each project boundary contributes its measured 14px gap");
  assert.equal(layout.offsetForIndex(keys.length), 684);
});

test("measurement cache stays bounded and follows stable keys after item reorder", () => {
  const layout = createVirtualLayout({ itemKeys: ["a", "b", "c", "d"], estimatedHeight: 100, maxMeasurements: 2 });
  layout.measure("a", 120, 0);
  layout.measure("b", 140, 1);
  layout.measure("a", 120, 0); // Refresh A in the LRU.
  layout.measure("c", 160, 2); // Evicts B.
  assert.equal(layout.measuredCount, 2);
  layout.setItems(["c", "a", "d", "b"]);
  assert.equal(layout.measuredCount, 2);
  assert.equal(layout.offsetForIndex(1), 160);
  assert.equal(layout.offsetForIndex(2), 280);
  assert.equal(layout.findIndexAt(280), 2);
});

test("empty and invalid viewports return finite empty or bounded ranges", () => {
  const empty = createVirtualLayout({ itemKeys: [] });
  assert.deepEqual(calculateVirtualRange(empty, { viewportHeight: 0 }), {
    start: 0, end: 0, offsetTop: 0, offsetBottom: 0, totalHeight: 0,
  });
  const layout = createVirtualLayout({ itemKeys: ["one", "two", "three"] });
  const range = calculateVirtualRange(layout, { scrollTop: Number.NaN, viewportHeight: 0, maxItems: 100 });
  assert.deepEqual([range.start, range.end], [0, 3]);
  assert.ok(Number.isFinite(range.totalHeight));
});
