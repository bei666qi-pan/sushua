import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createLearnerResolutionService } from "../src/features/auth/learner-resolution";
import { createLegacyClaimService } from "../src/features/legacy/legacy-claim";
import { createWorkspaceClaimHandler } from "../src/features/workspace/claim-api";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const ownerKey = "2".repeat(32);

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

function request(ownerKeyValue: string) {
  return new Request("https://sushua.test/api/v1/workspaces/id/claim", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "legacy-claim-1" },
    body: JSON.stringify({ legacy_owner_key: ownerKeyValue }),
  });
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
  await admin.query("GRANT EXECUTE ON FUNCTION resolve_authenticated_learner(uuid) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION claim_legacy_workspace(text) TO sushua_web_test");

  const userId = uuidv7();
  const placeholderId = uuidv7();
  const workspaceId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, 'legacy-api@example.com', '旧用户')", [userId]);
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [placeholderId]);
  await admin.query("INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1, 'legacy-api', '旧题库 API', 'private', $2)", [workspaceId, placeholderId]);
  await admin.query("INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1, $2, 'owner')", [workspaceId, placeholderId]);
  await admin.query("INSERT INTO legacy_bank_mappings (legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum) VALUES ('1', 'legacy-api', $1, $2, $3)", [workspaceId, createHash("sha256").update(ownerKey).digest("hex"), "f".repeat(64)]);

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const handler = createWorkspaceClaimHandler({
    enabled: true,
    readUser: async () => ({ id: userId }),
    legacyClaims: createLegacyClaimService(runtime),
    learners: createLearnerResolutionService(runtime),
  });

  console.log("Legacy owner claim API");
  const invalid = await handler(request("0".repeat(32)), workspaceId);
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, "invalid_legacy_owner_key");
  assert.equal((await admin.query("SELECT claimed_at FROM legacy_bank_mappings WHERE workspace_id = $1", [workspaceId])).rows[0]?.claimed_at, null);
  console.log("  ✓ 错误 owner key 返回结构化 401 且不修改 mapping");

  const response = await handler(request(ownerKey), workspaceId);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.data.status, "claimed");
  assert.equal(body.data.workspace_id, workspaceId);
  const learner = await admin.query<{ id: string }>("SELECT id FROM learners WHERE user_id = $1", [userId]);
  assert.equal(body.data.learner_id, learner.rows[0]?.id);
  console.log("  ✓ 登录用户无需游客 Cookie 即可凭旧 owner key 认领 Workspace");

  const repeated = await handler(request(ownerKey), workspaceId);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).data.status, "already_claimed");
  console.log("  ✓ API 重放保持幂等");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
