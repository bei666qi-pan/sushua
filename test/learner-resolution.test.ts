import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7, version as uuidVersion } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createLearnerResolutionService } from "../src/features/auth/learner-resolution";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
        CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$
  `);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION resolve_authenticated_learner(uuid) TO sushua_web_test");

  const userId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
    userId,
    "learner@example.com",
    "学习者",
  ]);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const learners = createLearnerResolutionService(runtime);

  console.log("登录用户 Learner 解析");
  const first = await learners.forUser(userId);
  assert.equal(uuidVersion(first), 7);
  const repeated = await learners.forUser(userId);
  assert.equal(repeated, first);
  const rows = await admin.query<{ id: string; user_id: string }>("SELECT id, user_id FROM learners");
  assert.deepEqual(rows.rows, [{ id: first, user_id: userId }]);
  console.log("  ✓ 首次创建 UUIDv7 Learner，跨请求稳定复用且不重复");

  await assert.rejects(() => learners.forUser(uuidv7()), /authenticated_user_not_found/);
  assert.equal((await admin.query("SELECT id FROM learners")).rowCount, 1);
  console.log("  ✓ 不存在的认证用户不能凭请求参数创建 Learner");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
