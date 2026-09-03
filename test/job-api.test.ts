import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7, version as uuidVersion } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createJobModule } from "../src/features/jobs/job-module";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

function request(input: {
  learnerId: string;
  method?: "GET" | "POST";
  idempotencyKey?: string;
  body?: unknown;
  signal?: AbortSignal;
}) {
  const headers = new Headers({ "x-test-learner": input.learnerId });
  if (input.idempotencyKey) headers.set("idempotency-key", input.idempotencyKey);
  if (input.body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://sushua.test/api/v1/jobs/job-id", {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: input.signal,
  });
}

async function main() {
  const apiModule = await import("../src/features/jobs/api").catch(() => null);
  assert.ok(apiModule, "Job HTTP Module must exist");
  assert.equal(typeof apiModule.createJobHandlers, "function");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT ON jobs, workspace_members TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION submit_job_v1(uuid, uuid, text, uuid, text, text, integer, jsonb, integer, uuid, uuid, timestamptz) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION request_job_cancel(uuid, text) TO sushua_web_test");

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const workspace = uuidv7();
  const otherWorkspace = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1), ($2), ($3)", [owner, viewer, outsider]);
  await admin.query(
    `INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES
       ($1, 'job-api-owner', '任务 API', 'private', $2),
       ($3, 'job-api-outsider', '其他租户', 'private', $4)`,
    [workspace, owner, otherWorkspace, outsider],
  );
  await admin.query(
    `INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES
       ($1, $2, 'owner'), ($1, $3, 'viewer'), ($4, $5, 'owner')`,
    [workspace, owner, viewer, otherWorkspace, outsider],
  );

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const jobs = createJobModule(runtime, {
    now: () => new Date("2026-09-01T08:00:00.000Z"),
    newId: uuidv7,
  });
  const created = await jobs.submit({ learnerId: owner, workspaceId: workspace }, {
    type: "document.parse",
    resourceId: uuidv7(),
    idempotencyKey: "job-api-read",
    priority: 1,
    budget: { maxCostFen: 20 },
    maxAttempts: 3,
  });

  let identityCalls = 0;
  const identity = {
    resolve: async (incoming: Request) => {
      identityCalls += 1;
      const learnerId = incoming.headers.get("x-test-learner");
      if (!learnerId) throw new Error("missing_test_identity");
      return learnerId === owner
        ? { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" }
        : { learnerId, userId: uuidv7(), kind: "user" as const };
    },
  };
  const handlers = apiModule.createJobHandlers({
    enabled: true,
    identity,
    jobs,
    stream: { pollIntervalMs: 1, maxDurationMs: 50 },
  });

  console.log("Job v1 HTTP API");
  const ownerRead = await handlers.GET(request({ learnerId: owner }), created.envelope.id);
  assert.equal(ownerRead.status, 200, await ownerRead.clone().text());
  const ownerBody = await ownerRead.json();
  assert.equal(uuidVersion(ownerBody.data.id), 7);
  assert.equal(ownerBody.data.workspace_id, workspace);
  assert.equal(ownerBody.data.state, "queued");
  assert.deepEqual(ownerBody.data.progress, {
    phase: "queued",
    percent: 0,
    updated_at: "2026-09-01T08:00:00.000Z",
  });
  assert.equal(ownerBody.meta.schema_version, "sushua.api.v1");
  assert.match(ownerRead.headers.get("set-cookie") ?? "", /HttpOnly/);
  console.log("  ✓ owner 可读取标准 v1 状态并刷新游客 Cookie");

  const viewerRead = await handlers.GET(request({ learnerId: viewer }), created.envelope.id);
  assert.equal(viewerRead.status, 200);
  const outsiderRead = await handlers.GET(request({ learnerId: outsider }), created.envelope.id);
  assert.equal(outsiderRead.status, 404);
  assert.equal((await outsiderRead.json()).error.code, "job_not_found");
  console.log("  ✓ viewer 可读，其他租户只获得防枚举 404");

  const outsiderStream = await handlers.STREAM(request({ learnerId: outsider }), created.envelope.id);
  assert.equal(outsiderStream.status, 404);
  assert.equal((await outsiderStream.json()).error.code, "job_not_found");
  console.log("  ✓ 其他租户不能通过 Stream 绕过 Job 隔离");

  const terminal = await jobs.submit({ learnerId: owner, workspaceId: workspace }, {
    type: "document.parse",
    resourceId: uuidv7(),
    idempotencyKey: "job-api-stream-terminal",
    priority: 1,
    budget: {},
    maxAttempts: 1,
  });
  await admin.query(
    `UPDATE jobs SET state='succeeded', progress=$2::jsonb, updated_at=$3 WHERE id=$1`,
    [terminal.envelope.id, JSON.stringify({ phase: "completed", percent: 100, updatedAt: "2026-09-01T08:01:00.000Z" }), "2026-09-01T08:01:00.000Z"],
  );
  const terminalStream = await handlers.STREAM(request({ learnerId: owner }), terminal.envelope.id);
  assert.equal(terminalStream.status, 200);
  assert.equal(terminalStream.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(terminalStream.headers.get("cache-control"), "no-cache, no-transform");
  const terminalEvents = await terminalStream.text();
  assert.match(terminalEvents, /^retry: 1000\n/);
  assert.match(terminalEvents, /event: job\n/);
  assert.match(terminalEvents, /"state":"succeeded"/);
  assert.match(terminalEvents, /event: done\ndata: \{"state":"succeeded"\}\n\n$/);
  console.log("  ✓ Stream 输出完整状态快照，终态明确 done 并关闭");

  const abortController = new AbortController();
  const liveStream = await handlers.STREAM(request({ learnerId: owner, signal: abortController.signal }), created.envelope.id);
  assert.equal(liveStream.status, 200);
  const liveReader = liveStream.body?.getReader();
  assert.ok(liveReader);
  const firstEvent = await liveReader.read();
  assert.equal(firstEvent.done, false);
  abortController.abort();
  let disconnected = false;
  for (let readCount = 0; readCount < 4; readCount += 1) {
    const afterAbort = await liveReader.read();
    if (afterAbort.done) {
      disconnected = true;
      break;
    }
  }
  assert.equal(disconnected, true);
  console.log("  ✓ 客户端断线会终止轮询并关闭 Stream");

  const beforeMissingKey = identityCalls;
  const missingKey = await handlers.CANCEL(request({ learnerId: owner, method: "POST", body: { reason: "user_requested" } }), created.envelope.id);
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "idempotency_key_required");
  assert.equal(identityCalls, beforeMissingKey);
  console.log("  ✓ 取消必须携带 Idempotency-Key，失败前不初始化身份");

  const viewerCancel = await handlers.CANCEL(request({
    learnerId: viewer,
    method: "POST",
    idempotencyKey: "cancel-viewer",
    body: { reason: "user_requested" },
  }), created.envelope.id);
  assert.equal(viewerCancel.status, 404);
  assert.equal((await viewerCancel.json()).error.code, "job_not_found");

  const outsiderCancel = await handlers.CANCEL(request({
    learnerId: outsider,
    method: "POST",
    idempotencyKey: "cancel-outsider",
    body: { reason: "user_requested" },
  }), created.envelope.id);
  assert.equal(outsiderCancel.status, 404);
  console.log("  ✓ viewer 和其他租户都不能取消 Job");

  const ownerCancelRequest = request({
    learnerId: owner,
    method: "POST",
    idempotencyKey: "cancel-owner",
    body: { reason: "user_requested" },
  });
  const ownerCancel = await handlers.CANCEL(ownerCancelRequest, created.envelope.id);
  assert.equal(ownerCancel.status, 200, await ownerCancel.clone().text());
  const cancelledBody = await ownerCancel.json();
  assert.equal(cancelledBody.data.state, "cancel_requested");
  assert.match(ownerCancel.headers.get("set-cookie") ?? "", /HttpOnly/);

  const replay = await handlers.CANCEL(request({
    learnerId: owner,
    method: "POST",
    idempotencyKey: "cancel-owner",
    body: { reason: "user_requested" },
  }), created.envelope.id);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.state, "cancel_requested");
  assert.equal((await admin.query("SELECT state FROM jobs WHERE id = $1", [created.envelope.id])).rows[0]?.state, "cancel_requested");
  console.log("  ✓ owner 取消成功，相同请求重放不产生第二个状态变化");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
