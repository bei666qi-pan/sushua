import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { reconcileLegacyWorkspaces } from "../src/features/legacy/legacy-reconcile";
import { createLegacySnapshot } from "../src/features/legacy/legacy-snapshot";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

function createRequest(title: string) {
  return new Request("https://sushua.test/api/banks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      visibility: "unlisted",
      questions: [{ type: "single", stem: "1+1=?", options: ["1", "2"], answer: "B" }],
    }),
  });
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "sushua-shadow-api-"));
  process.env.DATA_DIR = directory;
  process.env.FEATURE_POSTGRES_SHADOW_WRITE = "true";
  process.env.DATABASE_URL = roleUrl(databaseUrl);

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

  const collectionRoute = await import("../src/app/api/banks/route");
  const itemRoute = await import("../src/app/api/banks/[slug]/route");
  const legacyDb = await import("../src/lib/db");
  const sqlite = legacyDb.getDb();
  sqlite.prepare("DELETE FROM questions WHERE bank_id = (SELECT id FROM banks WHERE slug = 'demo')").run();
  sqlite.prepare("DELETE FROM banks WHERE slug = 'demo'").run();
  sqlite.prepare("DELETE FROM sqlite_sequence WHERE name = 'banks'").run();

  console.log("Legacy Bank API shadow write");
  const pendingResponse = await collectionRoute.POST(createRequest("待对账题库"));
  assert.equal(pendingResponse.status, 200);
  const pendingBody = await pendingResponse.json();
  assert.deepEqual(pendingBody.shadow_sync, { state: "pending_reconciliation", error_code: "shadow_write_failed" });
  assert.ok(legacyDb.getBank(pendingBody.slug));
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM legacy_bank_mappings")).rows[0]?.count, 0);
  console.log("  ✓ PostgreSQL 镜像失败时 SQLite 主写保留，响应明确标记 pending 而非伪造同步");

  await admin.query("GRANT EXECUTE ON FUNCTION shadow_sync_legacy_workspace(text, text, text, text, text, text, timestamptz, uuid, uuid) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION shadow_delete_legacy_workspace(text, text) TO sushua_web_test");

  const createdResponse = await collectionRoute.POST(createRequest("已同步题库"));
  assert.equal(createdResponse.status, 200);
  const createdBody = await createdResponse.json();
  assert.equal(createdBody.shadow_sync.state, "synced");
  assert.equal(createdBody.shadow_sync.action, "created");
  const mirrored = await admin.query("SELECT w.title, w.visibility::text FROM legacy_bank_mappings lbm JOIN workspaces w ON w.id = lbm.workspace_id WHERE lbm.legacy_slug = $1", [createdBody.slug]);
  assert.deepEqual(mirrored.rows[0], { title: "已同步题库", visibility: "link" });
  console.log("  ✓ create 在 SQLite 成功后镜像 Workspace/mapping");

  const patchResponse = await itemRoute.PATCH(new Request(`https://sushua.test/api/banks/${createdBody.slug}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-owner-key": createdBody.ownerKey },
    body: JSON.stringify({ title: "已改名题库", visibility: "public" }),
  }), { params: Promise.resolve({ slug: createdBody.slug }) });
  assert.equal(patchResponse.status, 200);
  assert.equal((await patchResponse.json()).shadow_sync.action, "updated");
  assert.deepEqual((await admin.query("SELECT w.title, w.visibility::text FROM legacy_bank_mappings lbm JOIN workspaces w ON w.id = lbm.workspace_id WHERE lbm.legacy_slug = $1", [createdBody.slug])).rows[0], {
    title: "已改名题库",
    visibility: "public",
  });
  console.log("  ✓ PATCH 重新计算完整 checksum 并同步 Workspace");

  const deleteResponse = await itemRoute.DELETE(new Request(`https://sushua.test/api/banks/${createdBody.slug}`, {
    method: "DELETE",
    headers: { "x-owner-key": createdBody.ownerKey },
  }), { params: Promise.resolve({ slug: createdBody.slug }) });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).shadow_sync.action, "deleted");
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM legacy_bank_mappings WHERE legacy_slug = $1", [createdBody.slug])).rows[0]?.count, 0);
  console.log("  ✓ DELETE 在保留旧权限验证后清理镜像");

  const retainedResponse = await collectionRoute.POST(createRequest("持续同步题库"));
  assert.equal(retainedResponse.status, 200);
  const retainedBody = await retainedResponse.json();
  assert.deepEqual(retainedBody.shadow_sync, { state: "synced", action: "created" });
  const snapshotPath = path.join(directory, "shadow-reconciliation.db");
  await createLegacySnapshot({ sourcePath: path.join(directory, "sushua.db"), snapshotPath });
  const reconciliation = await reconcileLegacyWorkspaces(admin, { snapshotPath });
  assert.deepEqual(reconciliation.summary, { total: 2, matched: 1, missing: 1, drifted: 0 });
  assert.deepEqual(reconciliation.items, [
    { legacyBankId: "1", slug: pendingBody.slug, status: "missing", reasons: ["mapping_missing"] },
    { legacyBankId: "3", slug: retainedBody.slug, status: "matched", reasons: [] },
  ]);
  console.log("  ✓ Online Backup 对账能区分已同步 Bank 与 pending Bank，差异可阻断读切换");

  await admin.end();
  await rm(directory, { recursive: true, force: true });
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
