import assert from "node:assert/strict";

async function main() {
  const clientModule = await import("../src/features/legacy/client").catch(() => null);
  assert.ok(clientModule, "legacy bank browser client module must exist");
  assert.equal(typeof clientModule.createLegacyBankClient, "function");
  assert.equal(typeof clientModule.legacyClaimReturnPath, "function");

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const ownerKey = "4".repeat(32);
  const client = clientModule.createLegacyBankClient(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json({
      data: { status: "claimed", learner_id: "learner-1", workspace_id: "workspace-1" },
      meta: { request_id: "request-1", schema_version: "sushua.api.v1" },
    });
  });
  const result = await client.claim("legacy-bank", ownerKey, "claim-key-1");
  assert.deepEqual(result, { status: "claimed", learner_id: "learner-1", workspace_id: "workspace-1" });
  assert.equal(calls[0]?.url, "/api/v1/legacy/banks/legacy-bank/claim");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(new Headers(calls[0]?.init?.headers).get("idempotency-key"), "claim-key-1");
  assert.equal(new Headers(calls[0]?.init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { owner_key: ownerKey });
  console.log("Legacy bank 浏览器客户端\n  ✓ owner key 只进入同源 POST 正文并携带幂等键");

  assert.equal(clientModule.legacyClaimReturnPath("legacy-bank"), "/b/legacy-bank?claim=1");
  const returnPath = clientModule.legacyClaimReturnPath("bank-with-dash");
  assert.equal(returnPath.includes("0123456789abcdef"), false);
  console.log("  ✓ 登录回流 URL 只含 slug 和待认领标记、不含管理凭证");

  const failingClient = clientModule.createLegacyBankClient(async () => Response.json({
    error: { code: "authentication_required", message: "请先登录后再认领", retryable: false },
    request_id: "request-2",
  }, { status: 401 }));
  const rejectedOwnerKey = "5".repeat(32);
  await assert.rejects(
    () => failingClient.claim("legacy-bank", rejectedOwnerKey, "claim-key-2"),
    (error) => error instanceof clientModule.LegacyBankClaimError
      && error.status === 401
      && error.code === "authentication_required"
      && !error.message.includes(rejectedOwnerKey),
  );
  console.log("  ✓ 结构化错误保留状态码且不携带 owner key");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
