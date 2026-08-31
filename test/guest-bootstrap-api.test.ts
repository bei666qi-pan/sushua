import assert from "node:assert/strict";
import { Pool } from "pg";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createGuestBootstrapHandler } from "../src/features/auth/guest-bootstrap-api";
import { createGuestSessionService } from "../src/features/auth/guest-session";

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

async function main() {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await prepareDatabase(admin);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const sessions = createGuestSessionService(runtime, {
    secret: "guest-api-integration-".repeat(3),
    now: () => new Date("2026-08-31T08:00:00.000Z"),
  });

  console.log("游客身份 API 契约");
  const disabled = createGuestBootstrapHandler({ sessions, enabled: false });
  const disabledResponse = await disabled(new Request("https://sushua.test/api/v1/identity/guest", { method: "POST" }));
  assert.equal(disabledResponse.status, 404);
  assert.equal((await admin.query("SELECT id FROM learners")).rowCount, 0);
  console.log("  ✓ Feature Flag 默认关闭时不创建身份");

  const enabled = createGuestBootstrapHandler({ sessions, enabled: true });
  const firstResponse = await enabled(new Request("https://sushua.test/api/v1/identity/guest", { method: "POST" }));
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json();
  assert.match(firstBody.data.learner_id, /^[0-9a-f-]{36}$/);
  assert.match(firstBody.meta.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(firstBody.meta.schema_version, "sushua.api.v1");
  assert.equal(JSON.stringify(firstBody).includes("v1."), false);
  const setCookie = firstResponse.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^sushua\.guest=v1\./);
  assert.match(setCookie, /HttpOnly/);
  console.log("  ✓ 返回标准 v1 envelope，原始证明只进入 HttpOnly Cookie");

  const browserCookie = setCookie.split(";", 1)[0];
  const repeatedResponse = await enabled(new Request("https://sushua.test/api/v1/identity/guest", {
    method: "POST",
    headers: { cookie: browserCookie },
  }));
  const repeatedBody = await repeatedResponse.json();
  assert.equal(repeatedBody.data.learner_id, firstBody.data.learner_id);
  assert.equal((await admin.query("SELECT id FROM learners")).rowCount, 1);
  console.log("  ✓ 浏览器回传 Cookie 后复用同一 Learner，不重复建档");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
