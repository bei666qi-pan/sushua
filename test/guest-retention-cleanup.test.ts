import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_worker_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const retentionModule = await import("../src/features/auth/guest-retention").catch(() => null);
  assert.ok(retentionModule, "guest retention cleanup module must exist");
  assert.equal(typeof retentionModule.createGuestRetentionService, "function");

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

  const expiredLearner = uuidv7();
  const emptyExpiredLearner = uuidv7();
  const activeLearner = uuidv7();
  const claimedLearner = uuidv7();
  const unsafeOwnerLearner = uuidv7();
  const claimedUser = uuidv7();
  await admin.query(
    "INSERT INTO users (id, email, name) VALUES ($1, 'retained@example.com', '已认领用户')",
    [claimedUser],
  );
  await admin.query(
    `INSERT INTO learners (id, user_id) VALUES
       ($1, NULL), ($2, NULL), ($3, NULL), ($4, $6), ($5, NULL)`,
    [expiredLearner, emptyExpiredLearner, activeLearner, claimedLearner, unsafeOwnerLearner, claimedUser],
  );
  await admin.query(
    `INSERT INTO guest_sessions (
       id, learner_id, token_hash, expires_at, last_seen_at, claimed_at, claimed_by_user_id
     ) VALUES
       ($1, $2, $3, '2026-08-01T00:00:00Z', '2026-07-02T00:00:00Z', NULL, NULL),
       ($4, $5, $6, '2026-08-02T00:00:00Z', '2026-07-03T00:00:00Z', NULL, NULL),
       ($7, $8, $9, '2026-10-01T00:00:00Z', '2026-09-01T00:00:00Z', NULL, NULL),
       ($10, $11, $12, '2026-08-01T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-15T00:00:00Z', $13),
       ($14, $15, $16, '2026-08-03T00:00:00Z', '2026-07-04T00:00:00Z', NULL, NULL)`,
    [
      uuidv7(), expiredLearner, "1".repeat(64),
      uuidv7(), emptyExpiredLearner, "2".repeat(64),
      uuidv7(), activeLearner, "3".repeat(64),
      uuidv7(), claimedLearner, "4".repeat(64), claimedUser,
      uuidv7(), unsafeOwnerLearner, "5".repeat(64),
    ],
  );

  const expiredWorkspace = uuidv7();
  const activeWorkspace = uuidv7();
  const claimedWorkspace = uuidv7();
  const foreignOwnedWorkspace = uuidv7();
  await admin.query(
    `INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES
       ($1, 'expired-guest', '过期游客资料', 'private', $2),
       ($3, 'active-guest', '活跃游客资料', 'private', $4),
       ($5, 'claimed-guest', '已认领资料', 'private', $6),
       ($7, 'foreign-owned', '异常 owner 资料', 'private', $4)`,
    [expiredWorkspace, expiredLearner, activeWorkspace, activeLearner, claimedWorkspace, claimedLearner, foreignOwnedWorkspace],
  );
  await admin.query(
    `INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES
       ($1, $2, 'owner'), ($3, $4, 'owner'), ($5, $6, 'owner'),
       ($3, $2, 'viewer'), ($7, $8, 'owner')`,
    [expiredWorkspace, expiredLearner, activeWorkspace, activeLearner, claimedWorkspace, claimedLearner, foreignOwnedWorkspace, unsafeOwnerLearner],
  );
  await admin.query(
    "INSERT INTO workspace_shares (id, workspace_id, token_hash) VALUES ($1, $2, $3)",
    [uuidv7(), expiredWorkspace, "6".repeat(64)],
  );
  await admin.query(
    `INSERT INTO legacy_bank_mappings (
       legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum
     ) VALUES ('901', 'expired-guest', $1, $2, $3)`,
    [expiredWorkspace, "7".repeat(64), "8".repeat(64)],
  );

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const retention = retentionModule.createGuestRetentionService(runtime);
  const cutoff = new Date("2026-08-31T00:00:00Z");

  console.log("游客 30 天保留清理");
  await assert.rejects(() => retention.purgeExpired({ before: cutoff, limit: 1 }), /permission denied/);
  console.log("  ✓ Worker 未显式授权时不能调用 SECURITY DEFINER 清理函数");

  await admin.query(
    "GRANT EXECUTE ON FUNCTION purge_expired_guest_learners(timestamptz, integer) TO sushua_worker_test",
  );
  await assert.rejects(
    () => retention.purgeExpired({ before: new Date("2027-01-01T00:00:00Z"), limit: 100 }),
    /invalid_guest_cleanup_cutoff/,
  );
  await assert.rejects(
    () => retention.purgeExpired({ before: cutoff, limit: 0 }),
    /invalid_guest_cleanup_limit/,
  );
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners")).rows[0]?.count, 5);
  console.log("  ✓ 未来 cutoff 与非法批量在任何删除前失败关闭");

  const first = await retention.purgeExpired({ before: cutoff, limit: 1 });
  assert.deepEqual(first, { purgedSessions: 1, purgedLearners: 1, purgedWorkspaces: 1 });
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners WHERE id = $1", [expiredLearner])).rows[0]?.count, 0);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspaces WHERE id = $1", [expiredWorkspace])).rows[0]?.count, 0);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspace_shares WHERE workspace_id = $1", [expiredWorkspace])).rows[0]?.count, 0);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM legacy_bank_mappings WHERE workspace_id = $1", [expiredWorkspace])).rows[0]?.count, 0);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspaces WHERE id = $1", [activeWorkspace])).rows[0]?.count, 1);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspace_members WHERE workspace_id = $1 AND learner_id = $2", [activeWorkspace, expiredLearner])).rows[0]?.count, 0);
  console.log("  ✓ 最早过期游客按批次删除自有 Workspace、分享、mapping 和跨 Workspace 成员关系");

  const second = await retention.purgeExpired({ before: cutoff, limit: 100 });
  assert.deepEqual(second, { purgedSessions: 1, purgedLearners: 1, purgedWorkspaces: 0 });
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners WHERE id = $1", [emptyExpiredLearner])).rows[0]?.count, 0);
  console.log("  ✓ 无内容的过期游客身份同样物理清理");

  const replay = await retention.purgeExpired({ before: cutoff, limit: 100 });
  assert.deepEqual(replay, { purgedSessions: 0, purgedLearners: 0, purgedWorkspaces: 0 });
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners WHERE id = $1", [activeLearner])).rows[0]?.count, 1);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners WHERE id = $1 AND user_id = $2", [claimedLearner, claimedUser])).rows[0]?.count, 1);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners WHERE id = $1", [unsafeOwnerLearner])).rows[0]?.count, 1);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspaces WHERE id IN ($1, $2, $3)", [activeWorkspace, claimedWorkspace, foreignOwnedWorkspace])).rows[0]?.count, 3);
  console.log("  ✓ 重放幂等，活跃、已认领及异常跨所有权 Learner 均保留");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
