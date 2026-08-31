import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createGuestClaimService } from "../src/features/auth/guest-claim";
import { createGuestSessionService } from "../src/features/auth/guest-session";
import { createWorkspaceClaimHandler } from "../src/features/workspace/claim-api";
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
  await pool.query("GRANT EXECUTE ON FUNCTION claim_guest_learner(text) TO sushua_web_test");
}

function claimRequest(cookie?: string) {
  return new Request("https://sushua.test/api/v1/workspaces/workspace-id/claim", {
    method: "POST",
    headers: {
      "idempotency-key": "claim-001",
      ...(cookie ? { cookie: `sushua.guest=${cookie}` } : {}),
    },
  });
}

async function main() {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await prepareDatabase(admin);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const guests = createGuestSessionService(runtime, {
    secret: "claim-api-integration-".repeat(3),
    now: () => new Date("2026-08-31T10:00:00.000Z"),
  });
  const claims = createGuestClaimService(runtime);
  const workspaces = createWorkspaceModule(runtime);
  const guest = await guests.ensure();
  const workspaceId = uuidv7();
  await workspaces.createWorkspace({ learnerId: guest.learnerId }, {
    id: workspaceId,
    slug: `claim-${workspaceId.slice(0, 8)}`,
    title: "待认领资料",
    visibility: "private",
  });
  const userId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [userId, "claim@example.com", "认领者"]);

  console.log("Workspace 认领 API");
  const unauthenticated = createWorkspaceClaimHandler({
    enabled: true,
    readUser: async () => null,
    guests,
    claims,
    workspaces,
  });
  const unauthenticatedResponse = await unauthenticated(claimRequest(guest.cookieValue), workspaceId);
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal((await unauthenticatedResponse.json()).error.code, "authentication_required");
  console.log("  ✓ 未登录用户不能认领");

  const handler = createWorkspaceClaimHandler({
    enabled: true,
    readUser: async () => ({ id: userId }),
    guests,
    claims,
    workspaces,
  });
  const wrongWorkspace = await handler(claimRequest(guest.cookieValue), uuidv7());
  assert.equal(wrongWorkspace.status, 404);
  assert.equal((await admin.query("SELECT user_id FROM learners WHERE id = $1", [guest.learnerId])).rows[0]?.user_id, null);
  console.log("  ✓ 请求中的 Workspace 必须由该游客 Learner 拥有");

  const claimed = await handler(claimRequest(guest.cookieValue), workspaceId);
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const claimedBody = await claimed.json();
  assert.deepEqual(claimedBody.data, { status: "claimed", learner_id: guest.learnerId });
  const bound = await admin.query<{ user_id: string }>("SELECT user_id FROM learners WHERE id = $1", [guest.learnerId]);
  assert.equal(bound.rows[0]?.user_id, userId);
  console.log("  ✓ 认领后 learner_id 保持不变并绑定认证用户");

  const repeated = await handler(claimRequest(guest.cookieValue), workspaceId);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).data.status, "already_claimed");
  console.log("  ✓ 同一认领请求可安全重放");

  const existingUserId = uuidv7();
  const existingLearnerId = uuidv7();
  const conflictGuest = await guests.ensure();
  const conflictWorkspaceId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
    existingUserId,
    "existing@example.com",
    "已有学习者",
  ]);
  await admin.query("INSERT INTO learners (id, user_id) VALUES ($1, $2)", [existingLearnerId, existingUserId]);
  await workspaces.createWorkspace({ learnerId: conflictGuest.learnerId }, {
    id: conflictWorkspaceId,
    slug: `conflict-${conflictWorkspaceId.slice(0, 8)}`,
    title: "冲突资料",
    visibility: "private",
  });
  const conflictHandler = createWorkspaceClaimHandler({
    enabled: true,
    readUser: async () => ({ id: existingUserId }),
    guests,
    claims,
    workspaces,
  });
  const conflict = await conflictHandler(claimRequest(conflictGuest.cookieValue), conflictWorkspaceId);
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error.code, "learner_merge_required");
  assert.equal(conflictBody.error.details.existing_learner_id, existingLearnerId);
  console.log("  ✓ 已有 Learner 时返回显式冲突报告，不静默合并");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
