import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createWorkspaceModule } from "../src/features/workspace/module";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required; integration tests must use a real PostgreSQL database");
}
const adminUrl: string = configuredDatabaseUrl;

const adminPool = new Pool({ connectionString: adminUrl, max: 2 });

function roleUrl(source: string, role: string, password: string): string {
  const url = new URL(source);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function prepareDatabase() {
  await adminPool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await adminPool.query("CREATE SCHEMA public");
  await adminPool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(adminPool);
  await applyPostgresMigrations(adminPool);

  const migrationDirectory = path.join(process.cwd(), "src/db/postgres/migrations");
  const expectedMigrationCount = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).length;
  const migrations = await adminPool.query<{ count: string }>("SELECT COUNT(*) AS count FROM schema_migrations");
  assert.equal(migrations.rows[0]?.count, String(expectedMigrationCount));
  console.log("  ✓ migration 可幂等重跑且不重复记录");

  await adminPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
        CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END
    $$;
  `);
  await adminPool.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await adminPool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sushua_web_test");
  await adminPool.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sushua_web_test");
}

async function main() {
  console.log("PostgreSQL migration");
  await prepareDatabase();

  const runtime = createPostgresRuntime({
    connectionString: roleUrl(adminUrl, "sushua_web_test", "integration-only"),
    maxConnections: 4,
  });
  const workspace = createWorkspaceModule(runtime);

  const learnerA = uuidv7();
  const learnerB = uuidv7();
  const guestA = uuidv7();
  const guestB = uuidv7();
  const workspaceA = uuidv7();
  const workspaceB = uuidv7();

  console.log("Learner 与 Guest Session");
  await workspace.createGuestIdentity({
    learnerId: learnerA,
    guestSessionId: guestA,
    tokenHash: "a".repeat(64),
    expiresAt: new Date("2026-09-30T00:00:00.000Z"),
  });

  await assert.rejects(
    workspace.createGuestIdentity({
      learnerId: uuidv7(),
      guestSessionId: uuidv7(),
      tokenHash: "not-a-sha256",
      expiresAt: new Date("2026-09-30T00:00:00.000Z"),
    }),
  );
  console.log("  ✓ Guest token 只能以 SHA256 形式持久化");
  await workspace.createGuestIdentity({
    learnerId: learnerB,
    guestSessionId: guestB,
    tokenHash: "b".repeat(64),
    expiresAt: new Date("2026-09-30T00:00:00.000Z"),
  });

  const ownLearner = await runtime.withTenant({ learnerId: learnerA }, async (tx) =>
    tx.query<{ id: string }>("SELECT id FROM learners ORDER BY id"),
  );
  assert.deepEqual(ownLearner.rows.map((row) => row.id), [learnerA]);
  console.log("  ✓ Learner RLS 只返回当前身份");

  const ownGuest = await runtime.withTenant({ learnerId: learnerA }, async (tx) =>
    tx.query<{ learner_id: string }>("SELECT learner_id FROM guest_sessions"),
  );
  assert.deepEqual(ownGuest.rows.map((row) => row.learner_id), [learnerA]);
  console.log("  ✓ Guest Session 不跨 Learner 暴露");

  console.log("Workspace 创建与隔离");
  await workspace.createWorkspace(
    { learnerId: learnerA },
    { id: workspaceA, slug: "workspace-a", title: "A 的私有资料", visibility: "private" },
  );
  await workspace.createWorkspace(
    { learnerId: learnerB },
    { id: workspaceB, slug: "workspace-b", title: "B 的私有资料", visibility: "private" },
  );

  assert.deepEqual(
    (await workspace.listVisibleWorkspaces({ learnerId: learnerA })).map((item) => item.id),
    [workspaceA],
  );
  assert.deepEqual(
    (await workspace.listVisibleWorkspaces({ learnerId: learnerB })).map((item) => item.id),
    [workspaceB],
  );
  console.log("  ✓ A/B 私有 Workspace 相互不可见");

  const guessed = await runtime.withTenant(
    { learnerId: learnerA, workspaceId: workspaceB },
    async (tx) => tx.query("SELECT id FROM workspaces WHERE id = $1", [workspaceB]),
  );
  assert.equal(guessed.rowCount, 0);
  console.log("  ✓ 猜测 B 的 workspace_id 仍被 RLS 拒绝");

  await assert.rejects(
    runtime.withTenant({ learnerId: learnerA, workspaceId: workspaceB }, async (tx) =>
      tx.query(
        "INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1, $2, 'viewer')",
        [workspaceB, learnerA],
      ),
    ),
  );
  console.log("  ✓ A 不能向 B 的 Workspace 写入成员关系");

  console.log("可见性与 owner 约束");
  await workspace.updateVisibility({ learnerId: learnerA, workspaceId: workspaceA }, "public");
  const publicForB = await workspace.listVisibleWorkspaces({ learnerId: learnerB });
  assert.deepEqual(publicForB.map((item) => item.id), [workspaceA, workspaceB]);
  console.log("  ✓ public 内容可见但不改变成员关系");

  await assert.rejects(
    adminPool.query(
      "INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1, $2, 'owner')",
      [workspaceA, learnerB],
    ),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23505",
  );
  console.log("  ✓ 每个 Workspace 只能有一个 owner");

  const rls = await adminPool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relname IN ('learners', 'guest_sessions', 'workspaces', 'workspace_members', 'workspace_shares', 'legacy_bank_mappings')
    ORDER BY relname
  `);
  assert.equal(rls.rows.length, 6);
  assert.ok(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  console.log("  ✓ 六张租户表全部启用并 FORCE RLS");

  const role = await adminPool.query<{ rolbypassrls: boolean }>(
    "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'sushua_web_test'",
  );
  assert.equal(role.rows[0]?.rolbypassrls, false);
  console.log("  ✓ Web 测试角色无 BYPASSRLS");

  await runtime.close();
  await adminPool.end();
  console.log("\n全部通过 ✓");
}

main().catch(async (error) => {
  console.error(error);
  await adminPool.end().catch(() => undefined);
  process.exit(1);
});
