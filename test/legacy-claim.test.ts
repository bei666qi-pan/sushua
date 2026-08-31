import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createLegacyClaimService } from "../src/features/legacy/legacy-claim";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const ownerKey = "1".repeat(32);
const ownerHash = createHash("sha256").update(ownerKey).digest("hex");

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
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION claim_legacy_workspace(text) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION claim_legacy_workspace_by_slug(text, text) TO sushua_web_test");

  const userId = uuidv7();
  const learnerId = uuidv7();
  const placeholderId = uuidv7();
  const workspaceId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, 'legacy@example.com', '旧用户')", [userId]);
  await admin.query("INSERT INTO learners (id, user_id) VALUES ($1, $2), ($3, NULL)", [learnerId, userId, placeholderId]);
  await admin.query("INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1, 'legacy-claim', '旧题库', 'private', $2)", [workspaceId, placeholderId]);
  await admin.query("INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1, $2, 'owner')", [workspaceId, placeholderId]);
  await admin.query("INSERT INTO legacy_bank_mappings (legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum) VALUES ('1', 'legacy-claim', $1, $2, $3)", [workspaceId, ownerHash, "c".repeat(64)]);

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const claims = createLegacyClaimService(runtime);
  console.log("Legacy owner key claim");
  const claimed = await claims.claim({ learnerId, userId, workspaceId }, { ownerKey });
  assert.deepEqual(claimed, { status: "claimed", learnerId, workspaceId });
  const workspace = await admin.query<{ created_by_learner_id: string }>("SELECT created_by_learner_id FROM workspaces WHERE id = $1", [workspaceId]);
  assert.equal(workspace.rows[0]?.created_by_learner_id, learnerId);
  const owners = await admin.query<{ learner_id: string }>("SELECT learner_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'", [workspaceId]);
  assert.deepEqual(owners.rows, [{ learner_id: learnerId }]);
  const mapping = await admin.query<{ claimed_by_learner_id: string; claimed_at: Date }>("SELECT claimed_by_learner_id, claimed_at FROM legacy_bank_mappings WHERE workspace_id = $1", [workspaceId]);
  assert.equal(mapping.rows[0]?.claimed_by_learner_id, learnerId);
  assert.ok(mapping.rows[0]?.claimed_at instanceof Date);
  console.log("  ✓ owner key 验证后转移 Workspace 与唯一 owner，并记录认领者");

  const repeated = await claims.claim({ learnerId, userId, workspaceId }, { ownerKey });
  assert.deepEqual(repeated, { status: "already_claimed", learnerId, workspaceId });
  console.log("  ✓ 相同账号重放幂等返回 already_claimed");

  const attackerUserId = uuidv7();
  const attackerLearnerId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, 'attacker@example.com', '另一用户')", [attackerUserId]);
  await admin.query("INSERT INTO learners (id, user_id) VALUES ($1, $2)", [attackerLearnerId, attackerUserId]);
  await assert.rejects(
    () => claims.claim({ learnerId: attackerLearnerId, userId: attackerUserId, workspaceId }, { ownerKey }),
    /legacy_workspace_already_claimed/,
  );
  assert.equal((await admin.query<{ created_by_learner_id: string }>("SELECT created_by_learner_id FROM workspaces WHERE id = $1", [workspaceId])).rows[0]?.created_by_learner_id, learnerId);
  console.log("  ✓ 认领后的旧 key 不能被另一账号用于夺取 Workspace");

  const wrongPlaceholder = uuidv7();
  const wrongWorkspace = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [wrongPlaceholder]);
  await admin.query("INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1, 'legacy-wrong', '错误 key', 'private', $2)", [wrongWorkspace, wrongPlaceholder]);
  await admin.query("INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1, $2, 'owner')", [wrongWorkspace, wrongPlaceholder]);
  await admin.query("INSERT INTO legacy_bank_mappings (legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum) VALUES ('2', 'legacy-wrong', $1, $2, $3)", [wrongWorkspace, "d".repeat(64), "e".repeat(64)]);
  await assert.rejects(
    () => claims.claim({ learnerId, userId, workspaceId: wrongWorkspace }, { ownerKey }),
    /invalid_legacy_owner_key/,
  );
  assert.equal((await admin.query<{ created_by_learner_id: string }>("SELECT created_by_learner_id FROM workspaces WHERE id = $1", [wrongWorkspace])).rows[0]?.created_by_learner_id, wrongPlaceholder);
  console.log("  ✓ 错误 owner key 不改变 placeholder 所有权");

  const slugPlaceholder = uuidv7();
  const slugWorkspace = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [slugPlaceholder]);
  await admin.query("INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1, 'legacy-by-slug', '按 slug 认领', 'private', $2)", [slugWorkspace, slugPlaceholder]);
  await admin.query("INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1, $2, 'owner')", [slugWorkspace, slugPlaceholder]);
  await admin.query("INSERT INTO legacy_bank_mappings (legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum) VALUES ('3', 'legacy-by-slug', $1, $2, $3)", [slugWorkspace, ownerHash, "a".repeat(64)]);
  const claimBySlug = (claims as unknown as {
    claimBySlug?: (
      context: { learnerId: string; userId: string },
      input: { slug: string; ownerKey: string },
    ) => Promise<{ status: string; learnerId: string; workspaceId: string }>;
  }).claimBySlug;
  assert.equal(typeof claimBySlug, "function", "legacy claim service must expose claimBySlug");
  const slugClaimed = await claimBySlug!({ learnerId, userId }, { slug: "legacy-by-slug", ownerKey });
  assert.deepEqual(slugClaimed, { status: "claimed", learnerId, workspaceId: slugWorkspace });
  assert.equal((await admin.query<{ created_by_learner_id: string }>("SELECT created_by_learner_id FROM workspaces WHERE id = $1", [slugWorkspace])).rows[0]?.created_by_learner_id, learnerId);
  assert.equal((await admin.query<{ claimed_by_learner_id: string }>("SELECT claimed_by_learner_id FROM legacy_bank_mappings WHERE legacy_slug = 'legacy-by-slug'")).rows[0]?.claimed_by_learner_id, learnerId);
  console.log("  ✓ 仅凭旧 slug 与 owner key 可原子解析并认领 Workspace");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
