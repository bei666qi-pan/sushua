import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { promisify } from "node:util";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const execFileAsync = promisify(execFile);

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_worker_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const scriptPath = path.join(process.cwd(), "scripts/cleanup-expired-guests.ts");
  assert.equal(existsSync(scriptPath), true, "guest cleanup CLI must exist");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_worker_test') THEN
      CREATE ROLE sushua_worker_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION purge_expired_guest_learners(timestamptz, integer) TO sushua_worker_test",
  );

  const learnerId = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
  await admin.query(
    `INSERT INTO guest_sessions (id, learner_id, token_hash, expires_at, last_seen_at)
     VALUES ($1, $2, $3, '2026-08-01T00:00:00Z', '2026-07-02T00:00:00Z')`,
    [uuidv7(), learnerId, "9".repeat(64)],
  );

  console.log("游客清理 CLI");
  let refused: unknown;
  try {
    await execFileAsync(process.execPath, [
      "--import", "tsx", scriptPath,
      "--before", "2026-08-31T00:00:00Z",
    ], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: roleUrl(databaseUrl) } });
  } catch (error) {
    refused = error;
  }
  assert.equal((refused as { code?: number }).code, 1);
  assert.match((refused as { stderr?: string }).stderr ?? "", /missing_guest_cleanup_commit/);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners WHERE id = $1", [learnerId])).rows[0]?.count, 1);
  console.log("  ✓ 未显式 --commit 时拒绝执行且不改变数据");

  const committed = await execFileAsync(process.execPath, [
    "--import", "tsx", scriptPath,
    "--before", "2026-08-31T00:00:00Z",
    "--limit", "100",
    "--commit",
  ], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: roleUrl(databaseUrl) } });
  assert.deepEqual(JSON.parse(committed.stdout), {
    before: "2026-08-31T00:00:00.000Z",
    limit: 100,
    purgedSessions: 1,
    purgedLearners: 1,
    purgedWorkspaces: 0,
  });
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners WHERE id = $1", [learnerId])).rows[0]?.count, 0);
  console.log("  ✓ 显式提交只输出 cutoff、批量大小和清理计数");

  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
