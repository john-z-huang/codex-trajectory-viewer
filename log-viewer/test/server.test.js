import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { access, appendFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { createLogServer } from "../server-dist/index.js";
import { openLogDownload, readLogPage } from "../server-dist/log-reader.js";

const instance = "1".repeat(32);
const name = "server-" + instance + "-1.jsonl";
const operationId = "b1234567-1234-4123-8123-123456789abc";
const requestId = "c1234567-1234-4123-8123-123456789abc";
const row = (index, overrides = {}) => JSON.stringify({ schema_version: 1, time: "2026-10-30T12:00:00+08:00", level: index % 2 ? "warn" : "info", source: "server", event: "event_" + index, seq: index, ...overrides });
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function fixture(t, content = row(1) + "\n") {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "ctv-independent-log-test-"));
  const logRoot = path.join(base, "logs"); const day = path.join(logRoot, "2026-10-30");
  await mkdir(day, { recursive: true }); const file = path.join(day, name); await writeFile(file, content);
  const root = path.join(base, "app"); await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<h1>Standalone synthetic log app</h1>");
  const server = createLogServer({ logRoot, root });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await rm(base, { recursive: true, force: true }); });
  async function get(url, options) { const response = await fetch(origin + url, options); return { status: response.status, headers: response.headers, data: await response.json() }; }
  const listed = await get("/api/logs"); assert.equal(listed.status, 200);
  return { base, logRoot, day, file, root, server, origin, get, id: listed.data.files[0].id, original: content };
}

test("safe discovery reads only real dates and owned stream filenames, ignoring sidecars and links", async (t) => {
  const f = await fixture(t); const before = await digest(f.file);
  await writeFile(path.join(f.day, ".owner-" + name), "PRIVATE_OWNER_MARKER");
  await writeFile(path.join(f.day, ".active-" + name), "PRIVATE_ACTIVE_MARKER");
  await writeFile(path.join(f.day, "unknown.jsonl"), "PRIVATE_UNKNOWN");
  await mkdir(path.join(f.logRoot, "2026-02-31")); await writeFile(path.join(f.logRoot, "2026-02-31", name), "PRIVATE_INVALID_DATE");
  const outside = path.join(f.base, "outside"); await mkdir(outside); await writeFile(path.join(outside, name), "PRIVATE_OUTSIDE");
  await symlink(outside, path.join(f.logRoot, "2026-10-29"));
  await symlink(path.join(outside, name), path.join(f.day, "http-" + instance + "-2.jsonl"));
  await link(path.join(outside, name), path.join(f.day, "browser-" + instance + "-3.jsonl"));
  const result = await f.get("/api/logs");
  assert.equal(result.status, 200); assert.equal(result.data.files.length, 1);
  assert.equal(result.data.files[0].name, name); assert.equal(result.data.files[0].source, "server");
  assert.equal(JSON.stringify(result.data).includes(f.base), false);
  assert.equal(await digest(f.file), before);
});

test("pages retain physical order, malformed and unknown records; filters and literal search preserve line numbers", async (t) => {
  const content = [row(1, { operation_id: operationId, request_id: requestId, note: "中文关键字 .*[]" }), "{broken", "", JSON.stringify({ unknown: [1, 2] }), row(5, { level: "error", source: "browser", note: "中文关键字" })].join("\n");
  const f = await fixture(t, content); const before = await digest(f.file);
  const first = await f.get("/api/logs/" + f.id + "?limit=2");
  assert.equal(first.status, 200); assert.equal(first.data.totalLines, 5); assert.equal(first.data.matchedLines, 5);
  assert.deepEqual(first.data.entries.map((entry) => entry.line), [1, 2]);
  assert.equal(first.data.entries[1].raw, "{broken"); assert.ok(first.data.entries[1].error); assert.equal(first.data.hasMore, true);
  const token = encodeURIComponent(first.data.revision);
  const next = await f.get("/api/logs/" + f.id + "?limit=2&afterLine=2&revision=" + token);
  assert.deepEqual(next.data.entries.map((entry) => entry.line), [3, 4]); assert.equal(next.data.entries[0].raw, "");
  const last = await f.get("/api/logs/" + f.id + "?limit=2&line=last&revision=" + token);
  assert.deepEqual(last.data.entries.map((entry) => entry.line), [4, 5]); assert.equal(last.data.hasMore, false);
  const jump = await f.get("/api/logs/" + f.id + "?line=4&revision=" + token); assert.equal(jump.data.entries[0].line, 4);
  for (const query of ["operationId=" + operationId, "requestId=" + requestId, "q=" + encodeURIComponent(".*[]")]) {
    const filtered = await f.get("/api/logs/" + f.id + "?" + query + "&revision=" + token);
    assert.equal(filtered.data.matchedLines, 1); assert.equal(filtered.data.entries[0].line, 1);
  }
  const combined = await f.get("/api/logs/" + f.id + "?level=error&source=browser&q=" + encodeURIComponent("中文关键字"));
  assert.equal(combined.data.entries.length, 1); assert.equal(combined.data.entries[0].line, 5);
  assert.equal(await digest(f.file), before);
});

test("signed snapshots survive append, download their original bytes, and reject rewrite, replacement and foreign revisions", async (t) => {
  const f = await fixture(t, row(1) + "\n" + row(2));
  const first = await f.get("/api/logs/" + f.id); const token = encodeURIComponent(first.data.revision);
  await appendFile(f.file, "\n" + row(3) + "\n");
  const older = await f.get("/api/logs/" + f.id + "?revision=" + token); assert.equal(older.status, 200); assert.equal(older.data.totalLines, 2);
  const download = await fetch(f.origin + "/api/logs/" + f.id + "/download?revision=" + token);
  assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition"), /attachment/); assert.equal(await download.text(), f.original);
  assert.equal((await f.get("/api/logs/" + f.id)).data.totalLines, 3);
  await writeFile(f.file, row(9) + "\n" + row(2) + "\n" + row(3) + "\n");
  const changed = await f.get("/api/logs/" + f.id + "?revision=" + token); assert.equal(changed.status, 409); assert.equal(changed.data.code, "stale_revision");
  const fresh = await f.get("/api/logs/" + f.id); await rename(f.file, f.file + ".old"); await writeFile(f.file, row(9) + "\n" + row(2) + "\n" + row(3) + "\n");
  assert.equal((await f.get("/api/logs/" + f.id + "?revision=" + encodeURIComponent(fresh.data.revision))).status, 409);
  const bad = await f.get("/api/logs/" + f.id + "?revision=invalid"); assert.ok([400, 409].includes(bad.status));
});

test("oversized UTF-8 lines have bounded previews and do not lose following records", async (t) => {
  const f = await fixture(t, row(1, { text: "中文".repeat(30_000) + "TAIL_MATCH_SENTINEL" }) + "\n" + row(2) + "\n");
  const result = await f.get("/api/logs/" + f.id);
  assert.equal(result.status, 200); assert.equal(result.data.totalLines, 2);
  assert.equal(result.data.entries[0].truncated, true);
  assert.ok(Buffer.byteLength(result.data.entries[0].raw, "utf8") <= 64 * 1024 + 3);
  assert.equal(result.data.entries[1].record.seq, 2);
  const searched = await f.get("/api/logs/" + f.id + "?q=TAIL_MATCH_SENTINEL");
  assert.equal(searched.data.matchedLines, 1); assert.equal(searched.data.entries[0].line, 1);
});

test("read-only HTTP boundaries reject writes, arbitrary paths, unsafe hosts and static symlinks", async (t) => {
  const f = await fixture(t); const before = await digest(f.file);
  assert.equal((await f.get("/api/logs", { method: "POST", body: "must not persist" })).status, 405);
  const unsafeHostStatus = await new Promise((resolve, reject) => {
    const req = request(f.origin + "/api/logs", { headers: { host: "rebind.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); });
    req.once("error", reject); req.end();
  });
  assert.equal(unsafeHostStatus, 403);
  const forbidden = Buffer.from("../outside/secret").toString("base64url");
  assert.equal((await f.get("/api/logs/" + forbidden)).status, 404);
  for (const query of ["limit=101", "limit=0", "afterLine=-1", "line=0", "q=" + "x".repeat(257)]) {
    assert.equal((await f.get("/api/logs/" + f.id + "?" + query)).status, 400);
  }
  const outside = path.join(f.base, "secret.txt"); await writeFile(outside, "PRIVATE_STATIC_SENTINEL");
  await symlink(outside, path.join(f.root, "dist", "alias.txt"));
  assert.equal((await fetch(f.origin + "/alias.txt")).status, 404);
  const home = await fetch(f.origin + "/"); assert.equal(home.status, 200); assert.match(await home.text(), /Standalone/);
  assert.ok(home.headers.get("content-security-policy"));
  assert.equal(await digest(f.file), before);
});

test("missing roots stay missing and a cancelled download leaves source bytes intact", async (t) => {
  const f = await fixture(t, row(1, { text: "z".repeat(2 * 1024 * 1024) }) + "\n");
  const before = await digest(f.file);
  const first = await f.get("/api/logs/" + f.id);
  await new Promise((resolve, reject) => {
    const req = request(f.origin + "/api/logs/" + f.id + "/download?revision=" + encodeURIComponent(first.data.revision), (response) => {
      response.once("data", () => { response.destroy(); resolve(); }); response.once("error", () => resolve());
    }); req.once("error", reject); req.end();
  });
  assert.equal(await digest(f.file), before);
  const missing = path.join(f.base, "missing"); const server = createLogServer({ logRoot: missing });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/logs");
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).files, []);
    await assert.rejects(access(missing));
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
});

test("aborted scans release handles and files above the segment budget are rejected", async (t) => {
  const f = await fixture(t); const before = await digest(f.file);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readLogPage(f.logRoot, f.id, new URLSearchParams(), controller.signal), (error) => error.status === 499 && error.code === "aborted");
  await assert.rejects(openLogDownload(f.logRoot, f.id, "", controller.signal), (error) => error.status === 499 && error.code === "aborted");
  assert.equal(await digest(f.file), before);
  await truncate(f.file, 10 * 1024 * 1024 + 1);
  assert.equal((await f.get("/api/logs/" + f.id)).status, 413);
});

test("discovery bounds all directory entries, including unknown names", async (t) => {
  const f = await fixture(t);
  for (let start = 0; start < 20_000; start += 200) {
    await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(path.join(f.logRoot, "unknown-" + (start + index)), "")));
  }
  const result = await f.get("/api/logs");
  assert.equal(result.status, 503); assert.equal(result.data.code, "scan_limit");
  assert.equal(JSON.stringify(result.data).includes(f.base), false);
});
