import assert from "node:assert/strict";
import { v7 as uuidv7 } from "uuid";

async function main() {
  const previous = new Map<string, string | undefined>();
  for (const name of ["FEATURE_ASYNC_INGESTION", "DATABASE_URL", "GUEST_SESSION_SECRET", "STORAGE_DRIVER", "S3_BUCKET"]) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    const route = await import("../src/app/api/v1/uploads/[id]/complete/route").catch(() => null);
    assert.ok(route, "upload completion route must exist");
    const assetId = uuidv7();
    const response = await route.POST(
      new Request(`https://sushua.test/api/v1/uploads/${assetId}/complete`, { method: "POST" }),
      { params: Promise.resolve({ id: assetId }) },
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "not_found");
    console.log("上传完成路由\n  ✓ Flag 默认关闭时不初始化 Auth/Postgres/Storage 即返回 404\n\n全部通过 ✓");
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
