import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "sushua-shadow-disabled-"));
  const previous = {
    dataDir: process.env.DATA_DIR,
    flag: process.env.FEATURE_POSTGRES_SHADOW_WRITE,
    database: process.env.DATABASE_URL,
  };
  process.env.DATA_DIR = directory;
  delete process.env.FEATURE_POSTGRES_SHADOW_WRITE;
  delete process.env.DATABASE_URL;
  try {
    const { POST } = await import("../src/app/api/banks/route");
    const response = await POST(new Request("https://sushua.test/api/banks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Flag 关闭题库",
        visibility: "private",
        questions: [{ type: "judge", stem: "题干", options: [], answer: "对" }],
      }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.slug, "string");
    assert.equal(typeof body.ownerKey, "string");
    assert.equal("shadow_sync" in body, false);
    console.log("Legacy shadow write Flag\n  ✓ 默认关闭时无需 PostgreSQL 配置，旧 API 响应保持不变\n\n全部通过 ✓");
  } finally {
    restore("DATA_DIR", previous.dataDir);
    restore("FEATURE_POSTGRES_SHADOW_WRITE", previous.flag);
    restore("DATABASE_URL", previous.database);
    await rm(directory, { recursive: true, force: true });
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
