import assert from "node:assert/strict";
import { POST } from "../src/app/api/v1/legacy/banks/[slug]/claim/route";

async function main() {
  const names = [
    "FEATURE_GUEST_CLAIM",
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "SMTP_URL",
    "AUTH_EMAIL_FROM",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  names.forEach((name) => delete process.env[name]);
  try {
    const response = await POST(
      new Request("https://sushua.test/api/v1/legacy/banks/legacy-route/claim", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "disabled-route" },
        body: JSON.stringify({ owner_key: "0".repeat(32) }),
      }),
      { params: Promise.resolve({ slug: "legacy-route" }) },
    );
    assert.equal(response.status, 404);
    console.log("Legacy bank claim 路由\n  ✓ Flag 默认关闭时不初始化 Auth/DB 且返回 404\n\n全部通过 ✓");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
