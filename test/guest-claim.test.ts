import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createGuestClaimService } from "../src/features/auth/guest-claim";
import { createWorkspaceModule } from "../src/features/workspace/module";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const adminUrl: string = configuredDatabaseUrl;
const adminPool = new Pool({ connectionString: adminUrl, max: 2 });

function roleUrl(source: string): string {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

async function prepareDatabase() {
  await adminPool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await adminPool.query("CREATE SCHEMA public");
  await adminPool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(adminPool);
  await adminPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
        CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END $$
  `);
  await adminPool.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await adminPool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sushua_web_test");
  await adminPool.query("GRANT EXECUTE ON FUNCTION claim_guest_learner(text) TO sushua_web_test");
}

async function createUser(id: string, email: string) {
  await adminPool.query(
    "INSERT INTO users (id, name, email, email_verified) VALUES ($1, $2, $3, true)",
    [id, email, email],
  );
}

async function main() {
  await prepareDatabase();
  const runtime = createPostgresRuntime({ connectionString: roleUrl(adminUrl) });
  const workspace = createWorkspaceModule(runtime);
  const claims = createGuestClaimService(runtime);

  const learnerId = uuidv7();
  const sessionId = uuidv7();
  const userId = uuidv7();
  const tokenHash = "c".repeat(64);
  await workspace.createGuestIdentity({
    learnerId,
    guestSessionId: sessionId,
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await createUser(userId, "learner@example.com");

  console.log("游客认领");
  const claimed = await claims.claim({ learnerId, userId }, { tokenHash });
  assert.deepEqual(claimed, { status: "claimed", learnerId });
  const bound = await adminPool.query<{ id: string; user_id: string }>(
    "SELECT id, user_id FROM learners WHERE id = $1",
    [learnerId],
  );
  assert.deepEqual(bound.rows[0], { id: learnerId, user_id: userId });
  console.log("  ✓ 认领绑定 user_id 且 learner_id 保持不变");

  const repeated = await claims.claim({ learnerId, userId }, { tokenHash });
  assert.deepEqual(repeated, { status: "already_claimed", learnerId });
  console.log("  ✓ 相同请求幂等返回 already_claimed");

  console.log("认领拒绝与冲突");
  const wrongLearner = uuidv7();
  await workspace.createGuestIdentity({
    learnerId: wrongLearner,
    guestSessionId: uuidv7(),
    tokenHash: "d".repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await assert.rejects(
    claims.claim({ learnerId: wrongLearner, userId: uuidv7() }, { tokenHash: "e".repeat(64) }),
    /invalid_guest_proof/,
  );
  console.log("  ✓ 错误 token 不认领");

  const expiredLearner = uuidv7();
  await workspace.createGuestIdentity({
    learnerId: expiredLearner,
    guestSessionId: uuidv7(),
    tokenHash: "f".repeat(64),
    expiresAt: new Date(Date.now() - 60_000),
  });
  await assert.rejects(
    claims.claim({ learnerId: expiredLearner, userId: uuidv7() }, { tokenHash: "f".repeat(64) }),
    /guest_session_expired/,
  );
  console.log("  ✓ 过期 Guest Session 不认领");

  const existingUserId = uuidv7();
  const existingLearnerId = uuidv7();
  const guestLearnerId = uuidv7();
  await createUser(existingUserId, "existing@example.com");
  await adminPool.query("INSERT INTO learners (id, user_id) VALUES ($1, $2)", [existingLearnerId, existingUserId]);
  await workspace.createGuestIdentity({
    learnerId: guestLearnerId,
    guestSessionId: uuidv7(),
    tokenHash: "1".repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const conflict = await claims.claim(
    { learnerId: guestLearnerId, userId: existingUserId },
    { tokenHash: "1".repeat(64) },
  );
  assert.deepEqual(conflict, {
    status: "conflict",
    learnerId: guestLearnerId,
    existingLearnerId,
  });
  const untouched = await adminPool.query<{ user_id: string | null }>("SELECT user_id FROM learners WHERE id = $1", [
    guestLearnerId,
  ]);
  assert.equal(untouched.rows[0]?.user_id, null);
  console.log("  ✓ 已有 Learner 时返回冲突且不改游客数据");

  await runtime.close();
  await adminPool.end();
  console.log("\n全部通过 ✓");
}

main().catch(async (error) => {
  console.error(error);
  await adminPool.end().catch(() => undefined);
  process.exit(1);
});
