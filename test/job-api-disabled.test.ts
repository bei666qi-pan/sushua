import assert from "node:assert/strict";

async function main() {
  const previousFlag = process.env.FEATURE_ASYNC_INGESTION;
  const previousDatabase = process.env.DATABASE_URL;
  const previousGuestSecret = process.env.GUEST_SESSION_SECRET;
  delete process.env.FEATURE_ASYNC_INGESTION;
  delete process.env.DATABASE_URL;
  delete process.env.GUEST_SESSION_SECRET;

  try {
    const statusRoute = await import("../src/app/api/v1/jobs/[id]/route").catch(() => null);
    const cancelRoute = await import("../src/app/api/v1/jobs/[id]/cancel/route").catch(() => null);
    assert.ok(statusRoute && cancelRoute, "Job status and cancel routes must exist");

    const context = { params: Promise.resolve({ id: "0199aa99-1111-7111-8111-111111111111" }) };
    const statusResponse = await statusRoute.GET(
      new Request("https://sushua.test/api/v1/jobs/0199aa99-1111-7111-8111-111111111111"),
      context,
    );
    const cancelResponse = await cancelRoute.POST(
      new Request("https://sushua.test/api/v1/jobs/0199aa99-1111-7111-8111-111111111111/cancel", {
        method: "POST",
      }),
      context,
    );

    assert.equal(statusResponse.status, 404);
    assert.equal(cancelResponse.status, 404);
    assert.equal((await statusResponse.json()).error.code, "not_found");
    assert.equal((await cancelResponse.json()).error.code, "not_found");
    console.log("Job v1 路由开关\n  ✓ 默认关闭时无需身份或数据库配置即返回 404\n\n全部通过 ✓");
  } finally {
    restore("FEATURE_ASYNC_INGESTION", previousFlag);
    restore("DATABASE_URL", previousDatabase);
    restore("GUEST_SESSION_SECRET", previousGuestSecret);
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
