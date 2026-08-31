import assert from "node:assert/strict";
import { WorkspaceApiError, createWorkspaceClient } from "../src/features/workspace/client";

async function main() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    Response.json({ data: { items: [{ id: "ws-1", title: "资料一", slug: "one", visibility: "private" }] }, meta: {} }),
    Response.json({ data: { id: "ws-2", title: "资料二", slug: "two", visibility: "link" }, meta: {} }, { status: 201 }),
    Response.json({ data: { status: "claimed", learner_id: "learner-1" }, meta: {} }),
    Response.json({ error: { code: "idempotency_conflict", message: "请求冲突", retryable: false }, request_id: "r1" }, { status: 409 }),
  ];
  const client = createWorkspaceClient(async (url, init) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected_fetch");
    return response;
  });

  console.log("Workspace 浏览器客户端");
  const items = await client.list();
  assert.deepEqual(items.map((item) => item.id), ["ws-1"]);
  assert.equal(calls[0]?.init?.method, "GET");
  console.log("  ✓ 读取标准 v1 列表 envelope");

  const created = await client.create({ title: "资料二", visibility: "link" }, "create-key");
  assert.equal(created.id, "ws-2");
  assert.equal(new Headers(calls[1]?.init?.headers).get("idempotency-key"), "create-key");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { title: "资料二", visibility: "link" });
  console.log("  ✓ 创建时发送幂等键与结构化正文");

  const claim = await client.claim("ws-2", "claim-key");
  assert.equal(claim.status, "claimed");
  assert.equal(calls[2]?.url, "/api/v1/workspaces/ws-2/claim");
  assert.equal(new Headers(calls[2]?.init?.headers).get("idempotency-key"), "claim-key");
  console.log("  ✓ 认领使用 Workspace 资源路径和幂等键");

  await assert.rejects(
    () => client.create({ title: "冲突", visibility: "private" }, "same-key"),
    (error) => error instanceof WorkspaceApiError && error.code === "idempotency_conflict" && error.status === 409,
  );
  console.log("  ✓ 服务端结构化错误保留 code 与状态码供界面展示");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
