function stringify(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function textPartsFromArray(items, depth = 0) {
  const textItems = items.some((item) => item && typeof item === "object" && typeof item.text === "string");
  if (!textItems) return [{ kind: "plain", text: stringify(items) }];

  return items.flatMap((item) => {
    if (item && typeof item === "object" && typeof item.text === "string") {
      return partsFromToolText(item.text, depth + 1);
    }
    return [{ kind: "plain", text: stringify(item) }];
  });
}

function partsFromToolText(value, depth = 0) {
  if (typeof value !== "string") return [{ kind: "plain", text: stringify(value) }];
  if (depth < 3 && value.trimStart().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.some((item) => item && typeof item === "object" && typeof item.text === "string")
          ? textPartsFromArray(parsed, depth + 1)
          : [{ kind: "plain", text: value }];
      }
    } catch {
      return [{ kind: "plain", text: value }];
    }
  }
  return [{ kind: "markdown", text: value }];
}

/** Convert tool output text or content-item arrays into safe display segments. */
export function toolOutputParts(value) {
  if (Array.isArray(value)) return textPartsFromArray(value);
  if (typeof value === "string") return partsFromToolText(value);
  return [{ kind: "plain", text: stringify(value) }];
}

/** Extract only textual MCP result items; preserve other structures as plain data. */
export function mcpToolResultParts(result) {
  const body = result?.Ok ?? result?.ok ?? result;
  if (body && typeof body === "object" && Array.isArray(body.content)) return textPartsFromArray(body.content);
  if (body && typeof body === "object" && Array.isArray(body.result?.content)) return textPartsFromArray(body.result.content);
  if (typeof body === "string") return [{ kind: "plain", text: body }];
  return [{ kind: "plain", text: stringify(result) }];
}

/** Keep relative links and permit only web/email schemes for absolute links. */
export function safeMarkdownUrl(value) {
  if (typeof value !== "string") return "";
  const url = value.trim();
  const normalizedForSchemeCheck = url.replace(/[\u0000-\u0020\u007f]/g, "");
  const scheme = normalizedForSchemeCheck.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "mailto"].includes(scheme)) return "";
  return url;
}
