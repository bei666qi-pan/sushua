import assert from "node:assert/strict";

async function main() {
  const releaseSha = "0123456789abcdef0123456789abcdef01234567";
  process.env.APP_VERSION = releaseSha;

  const { GET } = await import("../src/app/api/health/route");
  const response = await GET();
  const body = (await response.json()) as { version?: string };

  assert.equal(body.version, releaseSha);
  console.log("  ✓ 健康接口返回当前发布提交");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
