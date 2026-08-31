import assert from "node:assert/strict";
import { Pool } from "pg";
import { version as uuidVersion } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createAuthRuntime } from "../src/features/auth/runtime";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");

async function jsonRequest(auth: ReturnType<typeof createAuthRuntime>, path: string, body?: unknown, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("origin", "https://sushua.example.test");
  return auth.handler(new Request(`https://sushua.example.test/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("missing_session_cookie");
  const match = header.match(/((?:__Secure-)?sushua\.session_token)=([^;]+)/);
  if (!match) throw new Error(`missing_session_token_cookie: ${header}`);
  return `${match[1]}=${match[2]}`;
}

async function main() {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(pool);

  let deliveredOTP: string | undefined;
  const auth = createAuthRuntime({
    pool,
    baseURL: "https://sushua.example.test",
    secret: "integration-test-".repeat(3),
    sendVerificationOTP: async ({ otp }) => {
      deliveredOTP = otp;
    },
  });

  console.log("Better Auth 邮箱 OTP 因果链");
  const send = await jsonRequest(auth, "/email-otp/send-verification-otp", {
    email: "Learner@Example.COM",
    type: "sign-in",
  });
  assert.equal(send.status, 200, await send.text());
  assert.match(deliveredOTP ?? "", /^\d{6}$/);
  const verification = await pool.query<{ identifier: string; value_hash: string }>(
    "SELECT identifier, value_hash FROM auth_verifications",
  );
  assert.equal(verification.rows.length, 1);
  assert.match(verification.rows[0]?.value_hash ?? "", /^[A-Za-z0-9_-]{43}:0$/);
  assert.notEqual(verification.rows[0]?.value_hash, deliveredOTP);
  console.log("  ✓ OTP 已真实生成和投递，数据库只保存哈希");

  const signIn = await jsonRequest(auth, "/sign-in/email-otp", {
    email: "Learner@Example.COM",
    otp: deliveredOTP,
  });
  const signInBody = await signIn.clone().json() as { user?: { id?: string; email?: string } };
  assert.equal(signIn.status, 200, JSON.stringify(signInBody));
  assert.equal(signInBody.user?.email, "learner@example.com");
  assert.equal(uuidVersion(signInBody.user?.id ?? ""), 7);
  const cookie = sessionCookie(signIn);
  const sessions = await pool.query<{ token_hash: string }>("SELECT token_hash FROM auth_sessions");
  assert.equal(sessions.rows.length, 1);
  assert.match(sessions.rows[0]?.token_hash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(cookie.includes(sessions.rows[0]?.token_hash ?? ""), false);
  console.log("  ✓ 新用户为 UUIDv7，邮箱归一化，会话库中只有 token 哈希");

  const current = await jsonRequest(auth, "/get-session", undefined, cookie);
  const currentBody = await current.json() as { user?: { email?: string } };
  assert.equal(current.status, 200);
  assert.equal(currentBody.user?.email, "learner@example.com");
  console.log("  ✓ 浏览器 cookie 可读取当前会话，数据库哈希未被当作 cookie 返回");

  const password = await jsonRequest(auth, "/sign-up/email", {
    email: "password@example.com",
    password: "not-allowed",
    name: "Password User",
  });
  assert.equal(password.status, 404);
  console.log("  ✓ 密码注册端点不可用");

  const signOut = await jsonRequest(auth, "/sign-out", {}, cookie);
  assert.equal(signOut.status, 200, await signOut.text());
  const afterSignOut = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM auth_sessions");
  assert.equal(afterSignOut.rows[0]?.count, "0");
  console.log("  ✓ 登出按哈希删除数据库会话");

  await pool.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
