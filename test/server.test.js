import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServer, discoverSessions } from "../server/index.js";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

function createDatabase(file, sql) {
  const db = new DatabaseSync(file);
  try { db.exec(sql); } finally { db.close(); }
}

test("仅发现 sessions / archived_sessions 下的 JSONL，并拒绝任意路径", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-"));
  const app = createAppServer({ home });
  await mkdir(path.join(home, "sessions", "2026", "01", "02"), { recursive: true });
  await mkdir(path.join(home, "archived_sessions"), { recursive: true });
  await mkdir(path.join(home, "outside"), { recursive: true });
  const activePath = path.join(home, "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
  const archivedPath = path.join(home, "archived_sessions", "archived.jsonl");
  await writeFile(activePath, `${JSON.stringify({ timestamp: "2026-01-02T00:00:00Z", type: "session_meta", payload: { id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/demo", initial_user_message: "活动样例" } })}\n{bad\n`);
  await writeFile(archivedPath, `${JSON.stringify({ timestamp: "2025-01-01T00:00:00Z", type: "session_meta", payload: { id: "archived-id", cwd: "/synthetic/archive", initial_user_message: "归档样例" } })}\n`);
  await writeFile(path.join(home, "outside", "secret.jsonl"), "secret");
  const statePath = path.join(home, "state_5.sqlite");
  createDatabase(statePath, "CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, model TEXT, tokens_used INTEGER, source TEXT, archived INTEGER, updated_at_ms INTEGER); INSERT INTO threads VALUES ('11111111-1111-4111-8111-111111111111', '合成 SQLite 标题', '/synthetic/repo', 'test-model', 128, 'cli', 0, 1767398400000);");
  const historyPath = path.join(home, "thread_history_1.sqlite");
  const historyRows = Array.from({ length: 53 }, (_, index) => `('11111111-1111-4111-8111-111111111111', 'turn-${index}', ${index})`).join(",");
  createDatabase(historyPath, `CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES ${historyRows}; INSERT INTO thread_items VALUES ${historyRows};`);
  const filesBefore = new Map(await Promise.all([activePath, archivedPath, statePath, historyPath].map(async (file) => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const address = app.address();
  assert.equal(address.address, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const listResponse = await fetch(`${base}/api/sessions`);
  const sessions = await listResponse.json();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.some((session) => session.archived), true);
  assert.equal("_path" in sessions[0], false);
  assert.equal(sessions.find((session) => session.sessionId === "archived-id").cwd, "/synthetic/archive");
  const activeSummary = sessions.find((session) => session.sessionId === "11111111-1111-4111-8111-111111111111");
  assert.equal(activeSummary.title, "合成 SQLite 标题");
  assert.equal(activeSummary.cwd, "/synthetic/repo");
  assert.equal(activeSummary.model, "test-model");
  assert.equal(activeSummary.tokens_used, 128);
  assert.equal(activeSummary.source, "cli");
  assert.equal(activeSummary.archived, false);
  assert.equal(activeSummary.updatedAt, "2026-01-03T00:00:00.000Z");
  const detail = await (await fetch(`${base}/api/sessions/${sessions[0].id}`)).json();
  assert.match(detail.contents, /\{bad/);
  assert.equal(detail.supplement.length, 3);
  assert.equal(detail.supplement.find((source) => source.database === "state_5.sqlite").tables[0].rows[0].title, "合成 SQLite 标题");
  const firstHistoryPage = detail.supplement.find((source) => source.database === "thread_history_1.sqlite").tables.find((table) => table.table === "thread_turns");
  assert.equal(firstHistoryPage.rows.length, 50);
  const nextDetail = await (await fetch(`${base}/api/sessions/${sessions[0].id}?historyPage=2`)).json();
  const secondHistoryPage = nextDetail.supplement.find((source) => source.database === "thread_history_1.sqlite").tables.find((table) => table.table === "thread_turns");
  assert.deepEqual(secondHistoryPage.rows.map((row) => row.rollout_ordinal), [50, 51, 52]);
  const denied = await fetch(`${base}/api/sessions/${encodeURIComponent(Buffer.from("../../outside/secret.jsonl").toString("base64url"))}`);
  assert.equal(denied.status, 404);
  for (const [file, hash] of filesBefore) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash, `${path.basename(file)} must remain unchanged`);
});

test("不跟随指向 CODEX_HOME 内其他目录的 sessions 根符号链接", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-session-link-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const unrelated = path.join(home, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "rollout.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "unrelated" } })}\n`);
  await symlink(unrelated, path.join(home, "sessions"));
  assert.deepEqual(await discoverSessions(home), []);
});
