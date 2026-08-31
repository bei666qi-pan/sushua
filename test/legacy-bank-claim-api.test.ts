import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createLearnerResolutionService } from "../src/features/auth/learner-resolution";
import { createLegacyClaimService } from "../src/features/legacy/legacy-claim";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const ownerKey = "3".repeat(32);

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

function request(ownerKeyValue: string, idempotencyKey = "legacy-claim-key") {
  return new Request("https://sushua.test/api/v1/legacy/banks/legacy-route/claim", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ owner_key: ownerKeyValue }),
  });
}

async function main() {
  const claimApiModule = await import("../src/features/legacy/legacy-bank-claim-api").catch(() => null);
  assert.ok(claimApiModule, "legacy bank claim API module must exist");
  const createHandler = claimApiModule.createLegacyBankClaimHandler;
  assert.equal(typeof createHandler, "function", "legacy bank claim API must export a handler factory");

  const disabled = createHandler({ enabled: false });
  const disabledResponse = await disabled(request(ownerKey), "legacy-route");
  assert.equal(disabledResponse.status, 404);
  console.log("Legacy bank claim API\n  ✓ Feature Flag 关闭时无需 DB/Auth 依赖即返回 404");

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
  await admin.query("GRANT EXECUTE ON FUNCTION resolve_authenticated_learner(uuid) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION claim_legacy_workspace_by_slug(text, text) TO sushua_web_test");

  const userId = uuidv7();
  const otherUserId = uuidv7();
  const placeholderId = uuidv7();
  const workspaceId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, 'legacy-route@example.com', '旧用户'), ($2, 'legacy-route-other@example.com', '其他用户')", [userId, otherUserId]);
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [placeholderId]);
  await admin.query("INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1, 'legacy-route', '旧题库路由', 'private', $2)", [workspaceId, placeholderId]);
  await admin.query("INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1, $2, 'owner')", [workspaceId, placeholderId]);
  await admin.query("INSERT INTO legacy_bank_mappings (legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum) VALUES ('1', 'legacy-route', $1, $2, $3)", [workspaceId, createHash("sha256").update(ownerKey).digest("hex"), "b".repeat(64)]);

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const claims = createLegacyClaimService(runtime);
  const learners = createLearnerResolutionService(runtime);
  const unauthenticated = createHandler({ enabled: true, readUser: async () => null, claims, learners });
  const unauthenticatedResponse = await unauthenticated(request(ownerKey), "legacy-route");
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal((await unauthenticatedResponse.json()).error.code, "authentication_required");
  console.log("  ✓ 未登录用户不能用本地 owner key 认领");

  const handler = createHandler({ enabled: true, readUser: async () => ({ id: userId }), claims, learners });
  const wrongKey = "0".repeat(32);
  const invalid = await handler(request(wrongKey), "legacy-route");
  const invalidText = await invalid.text();
  assert.equal(invalid.status, 401);
  assert.equal(JSON.parse(invalidText).error.code, "invalid_legacy_owner_key");
  assert.equal(invalidText.includes(wrongKey), false);
  assert.equal((await admin.query("SELECT claimed_at FROM legacy_bank_mappings WHERE legacy_slug = 'legacy-route'")).rows[0]?.claimed_at, null);
  console.log("  ✓ 错误 owner key 返回结构化 401、不回显凭证且不修改 mapping");

  const claimed = await handler(request(ownerKey), "legacy-route");
  const claimedText = await claimed.text();
  assert.equal(claimed.status, 200, claimedText);
  assert.equal(claimedText.includes(ownerKey), false);
  const claimedBody = JSON.parse(claimedText);
  assert.equal(claimedBody.data.status, "claimed");
  assert.equal(claimedBody.data.workspace_id, workspaceId);
  console.log("  ✓ 正确 slug/key 仅在认证后解析并返回已认领 Workspace");

  const otherHandler = createHandler({ enabled: true, readUser: async () => ({ id: otherUserId }), claims, learners });
  const conflict = await otherHandler(request(ownerKey, "legacy-bank-claim-other"), "legacy-route");
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "workspace_already_claimed");
  console.log("  ✓ 旧 key 不能被另一账号用于夺权");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
