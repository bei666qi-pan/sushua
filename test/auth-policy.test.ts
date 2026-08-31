import assert from "node:assert/strict";
import { version as uuidVersion } from "uuid";
import { createAuthPolicy } from "../src/features/auth/auth-policy";

async function main() {
  const sent: string[] = [];
  const options = createAuthPolicy({
    baseURL: "https://sushua.example.test",
    secret: "test-secret-at-least-32-characters-long",
    database: (() => {
      throw new Error("database adapter is not used by this policy test");
    }) as never,
    sendVerificationOTP: async ({ email }) => {
      sent.push(email);
    },
  });

  console.log("Better Auth P0 策略");
  assert.equal(options.emailAndPassword?.enabled, false);
  assert.deepEqual(options.socialProviders, {});
  assert.equal(options.plugins?.length, 1);
  const plugin = options.plugins?.[0];
  assert.equal(plugin?.id, "email-otp");
  assert.deepEqual(plugin?.options && {
    storeOTP: plugin.options.storeOTP,
    expiresIn: plugin.options.expiresIn,
    allowedAttempts: plugin.options.allowedAttempts,
    rateLimit: plugin.options.rateLimit,
  }, {
    storeOTP: "hashed",
    expiresIn: 300,
    allowedAttempts: 3,
    rateLimit: { window: 60, max: 3 },
  });
  console.log("  ✓ 仅启用邮箱 OTP，密码和社交登录关闭");
  console.log("  ✓ OTP 哈希存储、5 分钟过期、3 次尝试、每分钟 3 次");

  const disabledPaths = new Set<string>(options.disabledPaths);
  for (const path of [
    "/sign-up/email",
    "/sign-in/email",
    "/request-password-reset",
    "/reset-password",
    "/reset-password/:token",
    "/change-password",
    "/email-otp/request-password-reset",
    "/forget-password/email-otp",
    "/email-otp/reset-password",
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
  ]) {
    assert.ok(disabledPaths.has(path), `${path} should be disabled`);
  }
  console.log("  ✓ 密码恢复与不可安全支持的多会话 token 端点显式禁用");

  const generateId = options.advanced?.database?.generateId;
  assert.equal(typeof generateId, "function");
  const id = typeof generateId === "function" ? generateId({ model: "user" }) : false;
  assert.equal(typeof id, "string");
  if (typeof id === "string") assert.equal(uuidVersion(id), 7);
  console.log("  ✓ Better Auth 主键使用 UUIDv7");

  assert.equal(options.account?.encryptOAuthTokens, true);
  assert.equal(sent.length, 0);
  console.log("  ✓ OAuth token 加密策略默认开启且配置阶段不发送邮件");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
