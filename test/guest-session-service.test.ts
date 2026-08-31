import assert from "node:assert/strict";
import { Pool } from "pg";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createGuestSessionService } from "../src/features/auth/guest-session";

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
}

async function main() {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await prepareDatabase(admin);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  let now = new Date("2026-08-31T00:00:00.000Z");
  const sessions = createGuestSessionService(runtime, {
    secret: "guest-integration-".repeat(3),
    now: () => now,
  });

  console.log("稳定游客身份");
  const first = await sessions.ensure();
  assert.match(first.cookieValue, /^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  const persisted = await admin.query<{ learner_id: string; token_hash: string; expires_at: Date }>(
    "SELECT learner_id, token_hash, expires_at FROM guest_sessions",
  );
  assert.equal(persisted.rows.length, 1);
  assert.equal(persisted.rows[0]?.learner_id, first.learnerId);
  assert.match(persisted.rows[0]?.token_hash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(first.cookieValue.includes(persisted.rows[0]?.token_hash ?? ""), false);
  assert.equal(persisted.rows[0]?.expires_at.toISOString(), "2026-09-30T00:00:00.000Z");
  console.log("  ✓ 首次创建 UUIDv7 Learner，Cookie 持原始证明，数据库只存哈希");

  now = new Date("2026-09-10T12:00:00.000Z");
  const repeated = await sessions.ensure(first.cookieValue);
  assert.equal(repeated.learnerId, first.learnerId);
  assert.equal(repeated.cookieValue, first.cookieValue);
  const refreshed = await admin.query<{ expires_at: Date; last_seen_at: Date }>(
    "SELECT expires_at, last_seen_at FROM guest_sessions WHERE learner_id = $1",
    [first.learnerId],
  );
  assert.equal(refreshed.rows[0]?.last_seen_at.toISOString(), now.toISOString());
  assert.equal(refreshed.rows[0]?.expires_at.toISOString(), "2026-10-10T12:00:00.000Z");
  assert.equal((await admin.query("SELECT id FROM learners")).rowCount, 1);
  console.log("  ✓ 刷新复用 learner_id，并从最后活动时间滚动保留 30 天");

  const claimProof = await sessions.getClaimProof(first.cookieValue);
  assert.deepEqual(claimProof, {
    learnerId: first.learnerId,
    tokenHash: persisted.rows[0]?.token_hash,
  });
  assert.equal(await sessions.getClaimProof(`${first.cookieValue.slice(0, -1)}x`), undefined);
  console.log("  ✓ 认领边界只返回已验证 Learner 与数据库 token hash");

  console.log("伪造与过期隔离");
  const forged = nonCanonicalEquivalentSignature(first.cookieValue);
  assert.notEqual(forged, first.cookieValue);
  assert.deepEqual(
    Buffer.from(forged.split(".").at(-1) ?? "", "base64url"),
    Buffer.from(first.cookieValue.split(".").at(-1) ?? "", "base64url"),
  );
  const replacementForForgery = await sessions.ensure(forged);
  assert.notEqual(replacementForForgery.learnerId, first.learnerId);
  console.log("  ✓ 签名被篡改时不会复用原 Learner");

  await admin.query("UPDATE guest_sessions SET expires_at = $1 WHERE learner_id = $2", [
    new Date("2026-09-01T00:00:00.000Z"),
    first.learnerId,
  ]);
  const replacementForExpiry = await sessions.ensure(first.cookieValue);
  assert.notEqual(replacementForExpiry.learnerId, first.learnerId);
  assert.notEqual(replacementForExpiry.learnerId, replacementForForgery.learnerId);
  console.log("  ✓ 数据库期限过期后旧 Cookie 不恢复访问并创建新身份");

  const cookie = sessions.serializeCookie(replacementForExpiry.cookieValue, { secure: true });
  assert.match(cookie, /^sushua\.guest=/);
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  console.log("  ✓ Cookie 为 30 天、HttpOnly、Secure、SameSite=Lax");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

function nonCanonicalEquivalentSignature(cookieValue: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = cookieValue.at(-1) ?? "";
  const index = alphabet.indexOf(last);
  assert.notEqual(index, -1);
  const replacement = alphabet[(index & 0b111100) | ((index + 1) & 0b000011)];
  return `${cookieValue.slice(0, -1)}${replacement}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
