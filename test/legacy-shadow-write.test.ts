import assert from "node:assert/strict";
import { Pool } from "pg";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import type { LegacyBankData } from "../src/features/legacy/legacy-snapshot";
import { v7 as uuidv7 } from "uuid";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

const bank: LegacyBankData = {
  legacyBankId: "41",
  slug: "shadow-bank",
  title: "影子题库",
  visibility: "unlisted",
  ownerKeyHash: "a".repeat(64),
  createdAt: "2026-09-01 01:00:00",
  checksum: "b".repeat(64),
  questions: [{
    id: "411",
    type: "single",
    stem: "题干",
    options: ["A", "B"],
    answer: "A",
    explanation: "",
    sort: 0,
    chapter: "",
  }],
};

async function main() {
  const shadowModule = await import("../src/features/legacy/legacy-shadow-write").catch(() => null);
  assert.ok(shadowModule, "legacy shadow write module must exist");
  assert.equal(typeof shadowModule.createLegacyShadowWriteService, "function");

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
  await admin.query("GRANT EXECUTE ON FUNCTION shadow_sync_legacy_workspace(text, text, text, text, text, text, timestamptz, uuid, uuid) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION shadow_delete_legacy_workspace(text, text) TO sushua_web_test");

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const shadow = shadowModule.createLegacyShadowWriteService(runtime);

  console.log("Legacy Bank shadow write");
  const created = await shadow.sync(bank);
  assert.equal(created.status, "created");
  const rows = await admin.query(`
    SELECT w.title, w.visibility::text, lbm.checksum, lbm.owner_key_hash,
      (SELECT COUNT(*)::int FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.role = 'owner') AS owners
    FROM legacy_bank_mappings lbm JOIN workspaces w ON w.id = lbm.workspace_id
    WHERE lbm.legacy_slug = 'shadow-bank'
  `);
  assert.deepEqual(rows.rows[0], {
    title: "影子题库",
    visibility: "link",
    checksum: "b".repeat(64),
    owner_key_hash: "a".repeat(64),
    owners: 1,
  });
  console.log("  ✓ create 镜像原子建立 placeholder Learner、Workspace、唯一 owner 和 mapping");

  const replayed = await shadow.sync(bank);
  assert.equal(replayed.status, "replayed");
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspaces")).rows[0]?.count, 1);
  console.log("  ✓ 相同 Bank 重放不产生重复资源");

  const updatedBank = { ...bank, title: "影子题库·已改名", visibility: "public", checksum: "c".repeat(64) };
  const updated = await shadow.sync(updatedBank);
  assert.equal(updated.status, "updated");
  assert.deepEqual((await admin.query("SELECT w.title, w.visibility::text, lbm.checksum FROM legacy_bank_mappings lbm JOIN workspaces w ON w.id = lbm.workspace_id WHERE lbm.legacy_slug = 'shadow-bank'")).rows[0], {
    title: "影子题库·已改名",
    visibility: "public",
    checksum: "c".repeat(64),
  });
  console.log("  ✓ update 同步标题、可见性和完整 checksum");

  await assert.rejects(() => shadow.sync({ ...updatedBank, ownerKeyHash: "d".repeat(64) }), /legacy_shadow_owner_mismatch/);
  assert.equal((await admin.query("SELECT owner_key_hash FROM legacy_bank_mappings WHERE legacy_slug = 'shadow-bank'")).rows[0]?.owner_key_hash, "a".repeat(64));
  console.log("  ✓ 既有 mapping 拒绝 owner hash 变更");

  const removed = await shadow.remove({ slug: bank.slug, ownerKeyHash: bank.ownerKeyHash });
  assert.equal(removed.status, "deleted");
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspaces")).rows[0]?.count, 0);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM legacy_bank_mappings")).rows[0]?.count, 0);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM learners")).rows[0]?.count, 0);
  console.log("  ✓ delete 清除 Workspace/mapping，仅在安全时回收 orphan placeholder Learner");

  const claimedBank: LegacyBankData = {
    ...bank,
    legacyBankId: "42",
    slug: "claimed-shadow-bank",
    title: "已认领影子题库",
    ownerKeyHash: "e".repeat(64),
    checksum: "f".repeat(64),
  };
  const claimed = await shadow.sync(claimedBank);
  const creator = await admin.query<{ created_by_learner_id: string }>(
    "SELECT created_by_learner_id FROM workspaces WHERE id = $1",
    [claimed.workspaceId],
  );
  const claimedLearnerId = creator.rows[0]?.created_by_learner_id;
  assert.ok(claimedLearnerId);
  const userId = uuidv7();
  await admin.query("INSERT INTO users (id, email, name) VALUES ($1, 'claimed-shadow@example.com', '已认领用户')", [userId]);
  await admin.query("UPDATE learners SET user_id = $1 WHERE id = $2", [userId, claimedLearnerId]);

  const removedClaimed = await shadow.remove({ slug: claimedBank.slug, ownerKeyHash: claimedBank.ownerKeyHash });
  assert.equal(removedClaimed.status, "deleted");
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM workspaces WHERE id = $1", [claimed.workspaceId])).rows[0]?.count, 0);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM legacy_bank_mappings WHERE legacy_slug = $1", [claimedBank.slug])).rows[0]?.count, 0);
  assert.deepEqual((await admin.query("SELECT user_id FROM learners WHERE id = $1", [claimedLearnerId])).rows[0], { user_id: userId });
  console.log("  ✓ 已绑定账号的 Learner 在旧 Bank 删除后仍保留稳定身份");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
