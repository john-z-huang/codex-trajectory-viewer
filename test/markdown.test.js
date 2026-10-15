import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mcpToolResultParts, safeMarkdownUrl, toolOutputParts } from "../src/lib/markdown-content.js";
import { markdownComponents } from "../src/lib/markdown-components.js";
import { parseRolloutText } from "../src/lib/rollout.js";

test("user/assistant text from response_item and event_msg is marked as Markdown", () => {
  const records = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# User" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "**Assistant**" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "- legacy user" } },
    { type: "event_msg", payload: { type: "agent_message", message: "> legacy assistant" } },
  ];
  const entries = parseRolloutText(records.map((record) => JSON.stringify(record)).join("\n"));
  assert.deepEqual(entries.map(({ kind, markdown }) => [kind, markdown]), [
    ["user", true], ["assistant", true], ["user", true], ["assistant", true],
  ]);
});

test("tool output JSON text lists render only text fields and preserve other objects", () => {
  const output = JSON.stringify([
    { type: "text", text: "## First" },
    { type: "image", data: "synthetic-image" },
    { type: "input_text", text: "**Second**" },
    { type: "input_audio", audio_url: "synthetic-audio" },
    { type: "encrypted_content", encrypted_content: "synthetic-ciphertext" },
  ]);
  assert.deepEqual(toolOutputParts(output), [
    { kind: "markdown", text: "## First" },
    { kind: "plain", text: JSON.stringify({ type: "image", data: "synthetic-image" }, null, 2) },
    { kind: "markdown", text: "**Second**" },
    { kind: "plain", text: JSON.stringify({ type: "input_audio", audio_url: "synthetic-audio" }, null, 2) },
    { kind: "plain", text: JSON.stringify({ type: "encrypted_content", encrypted_content: "synthetic-ciphertext" }, null, 2) },
  ]);
  assert.deepEqual(toolOutputParts([{ type: "text", text: "one" }, { type: "text", text: "two" }]), [
    { kind: "markdown", text: "one" }, { kind: "markdown", text: "two" },
  ]);
});

test("invalid or non-text JSON arrays remain plain instead of being interpreted as Markdown", () => {
  assert.deepEqual(toolOutputParts("[{broken"), [{ kind: "plain", text: "[{broken" }]);
  assert.deepEqual(toolOutputParts('[{"type":"image","data":"x"}]'), [{ kind: "plain", text: '[{"type":"image","data":"x"}]' }]);
  assert.deepEqual(toolOutputParts({ value: 1 }), [{ kind: "plain", text: '{\n  "value": 1\n}' }]);
});

test("MCP result text items render as Markdown while non-text items stay plain", () => {
  assert.deepEqual(mcpToolResultParts({ Ok: { content: [
    { type: "text", text: "### MCP result" },
    { type: "image", data: "synthetic-image" },
  ] } }), [
    { kind: "markdown", text: "### MCP result" },
    { kind: "plain", text: '{\n  "type": "image",\n  "data": "synthetic-image"\n}' },
  ]);
});

test("rollout tool result records expose text segments for function/custom and MCP outputs", () => {
  const records = [
    { type: "response_item", payload: { type: "function_call_output", name: "tool-a", output: '[{"type":"text","text":"**function output**"}]' } },
    { type: "response_item", payload: { type: "custom_tool_call_output", name: "tool-b", output: [{ type: "input_text", text: "*custom output*" }] } },
    { type: "event_msg", payload: { type: "mcp_tool_call_end", result: { Ok: { content: [{ type: "text", text: "## MCP output" }] } } } },
  ];
  const entries = parseRolloutText(records.map((record) => JSON.stringify(record)).join("\n"));
  assert.deepEqual(entries.map((entry) => entry.contentParts?.[0]), [
    { kind: "markdown", text: "**function output**" },
    { kind: "markdown", text: "*custom output*" },
    { kind: "markdown", text: "## MCP output" },
  ]);
  assert.match(entries[0].raw, /function_call_output/);
});

test("CommonMark renderer omits raw HTML and rejects script URL schemes", () => {
  const source = "# Safe\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n[safe](https://example.com)\n\n![tracking image](https://example.com/track.gif)";
  const markup = renderToStaticMarkup(React.createElement(ReactMarkdown, { urlTransform: safeMarkdownUrl, components: markdownComponents }, source));
  assert.match(markup, /<h1>Safe<\/h1>/);
  assert.doesNotMatch(markup, /<script/i);
  assert.doesNotMatch(markup, /<img\b/i);
  assert.match(markup, /\[图片：tracking image\]/);
  assert.doesNotMatch(markup, /href="javascript:/i);
  assert.match(markup, /href="https:\/\/example\.com"/);
  assert.equal(safeMarkdownUrl("data:text/html,boom"), "");
  assert.equal(safeMarkdownUrl("java\nscript:alert(1)"), "");
  assert.equal(safeMarkdownUrl("mailto:user@example.com"), "mailto:user@example.com");
  assert.equal(safeMarkdownUrl("#section"), "#section");
});

test("command output events remain plain JSON rather than Markdown", () => {
  const [entry] = parseRolloutText(JSON.stringify({ type: "event_msg", payload: { exec_command_end: { stdout: "**literal output**", exit_code: 0 } } }));
  assert.equal(entry.kind, "tool-result");
  assert.equal(entry.markdown, undefined);
  assert.match(entry.text, /\*\*literal output\*\*/);
});

test("parsing and rendering a synthetic rollout leaves its source file unchanged", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-markdown-readonly-"));
  const rolloutPath = path.join(directory, "rollout.jsonl");
  const original = `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "**read-only**" }] } })}\n`;
  await writeFile(rolloutPath, original);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const before = hash(await readFile(rolloutPath));
  const [entry] = parseRolloutText(await readFile(rolloutPath, "utf8"));
  const rendered = renderToStaticMarkup(React.createElement(ReactMarkdown, { urlTransform: safeMarkdownUrl }, entry.text));
  assert.match(rendered, /<strong>read-only<\/strong>/);
  assert.equal(hash(await readFile(rolloutPath)), before);
});
