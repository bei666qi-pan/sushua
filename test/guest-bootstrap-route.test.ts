import assert from "node:assert/strict";
import { POST } from "../src/app/api/v1/identity/guest/route";

async function main() {
  const previousFlag = process.env.FEATURE_GUEST_CLAIM;
  const previousDatabase = process.env.DATABASE_URL;
  const previousSecret = process.env.GUEST_SESSION_SECRET;
  delete process.env.FEATURE_GUEST_CLAIM;
  delete process.env.DATABASE_URL;
  delete process.env.GUEST_SESSION_SECRET;
  try {
    const response = await POST(new Request("https://sushua.test/api/v1/identity/guest", { method: "POST" }));
    assert.equal(response.status, 404);
    console.log("游客身份路由\n  ✓ 默认关闭时无需数据库或密钥配置并返回 404\n\n全部通过 ✓");
  } finally {
    restore("FEATURE_GUEST_CLAIM", previousFlag);
    restore("DATABASE_URL", previousDatabase);
    restore("GUEST_SESSION_SECRET", previousSecret);
  }
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
