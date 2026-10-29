import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TEXT_FRAGMENT_SIZE, getTextFragment, getTextFragmentCount, isLongText } from "../src/lib/text-fragments.js";

function collectFragments(text) {
  const count = getTextFragmentCount(text);
  return Array.from({ length: count }, (_, index) => getTextFragment(text, index));
}

test("1 MiB and 10 MiB bodies render in bounded fragments and reconstruct without loss", () => {
  for (const size of [1024 * 1024, 10 * 1024 * 1024]) {
    const text = "a🙂b漢字".repeat(Math.ceil(size / 6)).slice(0, size);
    const fragments = collectFragments(text);
    assert.ok(fragments.length > 1);
    assert.ok(fragments.every((fragment) => fragment.length <= DEFAULT_TEXT_FRAGMENT_SIZE + 1));
    assert.equal(fragments.join(""), text);
    assert.equal(isLongText(text), true);
  }
});

test("fragment boundaries never split a UTF-16 surrogate pair", () => {
  const text = `${"x".repeat(DEFAULT_TEXT_FRAGMENT_SIZE - 1)}🙂${"y".repeat(10)}`;
  const fragments = collectFragments(text);
  assert.equal(fragments.join(""), text);
  for (const fragment of fragments) {
    if (!fragment) continue;
    const first = fragment.charCodeAt(0);
    const last = fragment.charCodeAt(fragment.length - 1);
    assert.ok(first < 0xdc00 || first > 0xdfff, "a fragment must not begin with a detached low surrogate");
    assert.ok(last < 0xd800 || last > 0xdbff, "a fragment must not end with a detached high surrogate");
  }
});

test("fragment reads clamp an out-of-range page and keep short text whole", () => {
  assert.equal(getTextFragment("small", 0), "small");
  assert.equal(getTextFragment("small", 5), "");
  assert.equal(getTextFragmentCount(""), 1);
  assert.equal(getTextFragment("", 0), "");
});
