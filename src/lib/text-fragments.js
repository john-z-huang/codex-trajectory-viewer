export const DEFAULT_TEXT_FRAGMENT_SIZE = 16 * 1024;

function safeBoundary(text, start, size) {
  let end = Math.min(text.length, start + size);
  if (end < text.length && end > start) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 1;
  }
  return end;
}

function normalizedSize(maxChars) {
  return Number.isFinite(maxChars) && maxChars > 0
    ? Math.max(1, Math.trunc(maxChars))
    : DEFAULT_TEXT_FRAGMENT_SIZE;
}

export function getTextFragmentCount(value, maxChars = DEFAULT_TEXT_FRAGMENT_SIZE) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!text.length) return 1;
  const size = normalizedSize(maxChars);
  let count = 0;
  let start = 0;
  while (start < text.length) {
    start = safeBoundary(text, start, size);
    count += 1;
  }
  return count;
}

export function getTextFragment(value, fragmentIndex, maxChars = DEFAULT_TEXT_FRAGMENT_SIZE) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!text.length) return "";
  const size = normalizedSize(maxChars);
  const target = Math.max(0, Math.trunc(fragmentIndex) || 0);
  let start = 0;
  let index = 0;
  while (start < text.length && index < target) {
    start = safeBoundary(text, start, size);
    index += 1;
  }
  if (start >= text.length) return "";
  const end = safeBoundary(text, start, size);
  return text.slice(start, end);
}

export function isLongText(value, maxChars = DEFAULT_TEXT_FRAGMENT_SIZE) {
  return typeof value === "string" && value.length > normalizedSize(maxChars);
}
