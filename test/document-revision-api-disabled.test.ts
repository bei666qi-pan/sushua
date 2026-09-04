import assert from "node:assert/strict";

async function main() {
  const api = await import("../src/features/documents/document-revision-api").catch(() => null) as {
    createDocumentRevisionBatchHandler?: (input: { enabled: boolean }) => (request: Request) => Promise<Response>;
  } | null;
  assert.ok(api?.createDocumentRevisionBatchHandler, "Document revision batch HTTP module must exist");

  const response = await api.createDocumentRevisionBatchHandler({ enabled: false })(
    new Request("https://sushua.test/api/v1/blocks/batch", { method: "PATCH" }),
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "not_found");

  const previousFlag = process.env.FEATURE_SOURCE_REVIEW;
  const previousDatabase = process.env.DATABASE_URL;
  const previousGuestSecret = process.env.GUEST_SESSION_SECRET;
  delete process.env.FEATURE_SOURCE_REVIEW;
  delete process.env.DATABASE_URL;
  delete process.env.GUEST_SESSION_SECRET;
  try {
    const route = await import("../src/app/api/v1/blocks/batch/route").catch(() => null);
    assert.ok(route, "Document revision batch route must exist");
    const routed = await route.PATCH(new Request("https://sushua.test/api/v1/blocks/batch", { method: "PATCH" }));
    assert.equal(routed.status, 404);
    assert.equal((await routed.json()).error.code, "not_found");
  } finally {
    restore("FEATURE_SOURCE_REVIEW", previousFlag);
    restore("DATABASE_URL", previousDatabase);
    restore("GUEST_SESSION_SECRET", previousGuestSecret);
  }
  console.log("Document revision batch route flag\n  ✓ 默认关闭时无需身份或数据库配置即返回 404\n\n全部通过 ✓");
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
