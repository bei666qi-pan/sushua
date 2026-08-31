import assert from "node:assert/strict";
import { readAuthServerConfig } from "../src/features/auth/server-config";

async function main() {
  console.log("认证服务配置");
  const config = readAuthServerConfig({
    DATABASE_URL: "postgresql://app:password@db/sushua",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "https://sushua.example.test",
    SMTP_URL: "smtp://mailer:password@mail:587",
    AUTH_EMAIL_FROM: "速刷 <login@example.test>",
  });
  assert.equal(config.baseURL, "https://sushua.example.test");
  assert.equal(config.emailFrom, "速刷 <login@example.test>");
  console.log("  ✓ 数据库、Auth URL、密钥和 SMTP 配置完整时可启动");

  for (const missing of ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "SMTP_URL", "AUTH_EMAIL_FROM"] as const) {
    const environment: Record<string, string | undefined> = {
      DATABASE_URL: "postgresql://app:password@db/sushua",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "https://sushua.example.test",
      SMTP_URL: "smtp://mailer:password@mail:587",
      AUTH_EMAIL_FROM: "速刷 <login@example.test>",
    };
    delete environment[missing];
    assert.throws(() => readAuthServerConfig(environment), new RegExp(`missing_auth_config:${missing}`));
  }
  console.log("  ✓ 任一必需项缺失均失败关闭且错误不包含配置值");

  assert.throws(() => readAuthServerConfig({
    DATABASE_URL: "postgresql://app:password@db/sushua",
    BETTER_AUTH_SECRET: "short",
    BETTER_AUTH_URL: "http://sushua.example.test",
    SMTP_URL: "smtp://mailer:password@mail:587",
    AUTH_EMAIL_FROM: "速刷 <login@example.test>",
  }), /invalid_auth_secret/);
  console.log("  ✓ 过短密钥被拒绝");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
