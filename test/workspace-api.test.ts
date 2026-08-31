import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7, version as uuidVersion } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createWorkspaceCollectionHandlers } from "../src/features/workspace/api";
import { createWorkspaceModule } from "../src/features/workspace/module";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

async function prepareDatabase(pool: Pool) {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(pool);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
        CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$
  `);
  await pool.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await pool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sushua_web_test");
}

function request(method: "GET" | "POST", body?: unknown, idempotencyKey?: string) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request("https://sushua.test/api/v1/workspaces", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function main() {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await prepareDatabase(admin);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const learnerId = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
  let identityCalls = 0;
  const identity = {
    resolve: async () => {
      identityCalls += 1;
      return { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" };
    },
  };
  const workspaces = createWorkspaceModule(runtime);

  console.log("Workspace v1 API");
  const disabled = createWorkspaceCollectionHandlers({ enabled: false, identity, workspaces });
  const disabledResponse = await disabled.GET(request("GET"));
  assert.equal(disabledResponse.status, 404);
  assert.equal(identityCalls, 0);
  console.log("  ✓ Feature Flag 关闭时不解析身份、不访问数据");

  const handlers = createWorkspaceCollectionHandlers({ enabled: true, identity, workspaces });
  const missingKey = await handlers.POST(request("POST", { title: "我的资料", visibility: "private" }));
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "idempotency_key_required");
  assert.equal((await admin.query("SELECT id FROM workspaces")).rowCount, 0);
  console.log("  ✓ 创建请求强制 Idempotency-Key");

  const first = await handlers.POST(request("POST", { title: "  我的资料  ", visibility: "private" }, "create-001"));
  assert.equal(first.status, 201, await first.clone().text());
  const firstBody = await first.json();
  assert.equal(uuidVersion(firstBody.data.id), 7);
  assert.equal(firstBody.data.title, "我的资料");
  assert.equal(firstBody.data.visibility, "private");
  assert.equal(firstBody.meta.schema_version, "sushua.api.v1");
  assert.match(first.headers.get("set-cookie") ?? "", /HttpOnly/);
  const owner = await admin.query<{ role: string }>("SELECT role FROM workspace_members WHERE workspace_id = $1", [
    firstBody.data.id,
  ]);
  assert.equal(owner.rows[0]?.role, "owner");
  console.log("  ✓ 创建 UUIDv7 Workspace 与唯一 owner，并刷新游客 Cookie");

  const replay = await handlers.POST(request("POST", { title: "我的资料", visibility: "private" }, "create-001"));
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.data.id, firstBody.data.id);
  assert.equal(replayBody.meta.idempotent_replay, true);
  assert.equal((await admin.query("SELECT id FROM workspaces")).rowCount, 1);
  console.log("  ✓ 相同键与相同正文稳定返回原资源，不重复创建");

  const conflict = await handlers.POST(request("POST", { title: "另一个资料", visibility: "private" }, "create-001"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  assert.equal((await admin.query("SELECT id FROM workspaces")).rowCount, 1);
  console.log("  ✓ 相同键配不同正文明确冲突，不静默复用");

  const list = await handlers.GET(request("GET"));
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.deepEqual(listBody.data.items.map((item: { id: string }) => item.id), [firstBody.data.id]);
  assert.equal(listBody.meta.next_cursor, null);
  console.log("  ✓ 列表只从 RLS 范围读取并返回 v1 envelope");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
