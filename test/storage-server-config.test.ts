import assert from "node:assert/strict";

async function main() {
  const storageModule = await import("../src/features/storage/server").catch(() => null);
  assert.ok(storageModule, "storage environment assembly must exist");
  const environment = {
    STORAGE_DRIVER: "s3",
    S3_REGION: "cn-beijing",
    S3_BUCKET: "sushua-private",
    S3_ENDPOINT: "https://s3.example.test",
    S3_ACCESS_KEY_ID: "integration-access",
    S3_SECRET_ACCESS_KEY: "integration-secret",
  };
  const adapter = storageModule.createStorageFromEnvironment(environment);
  assert.equal(typeof adapter.createUpload, "function");
  assert.equal(typeof adapter.resumeUpload, "function");

  for (const name of ["STORAGE_DRIVER", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
    const invalid = { ...environment };
    delete invalid[name];
    assert.throws(
      () => storageModule.createStorageFromEnvironment(invalid),
      (error: unknown) => error instanceof Error
        && error.message === `missing_storage_config:${name}`
        && !error.message.includes("integration-secret"),
    );
  }
  assert.throws(
    () => storageModule.createStorageFromEnvironment({ ...environment, S3_ENDPOINT: "file:///tmp/storage" }),
    /invalid_storage_config:S3_ENDPOINT/,
  );
  console.log("S3 环境装配\n  ✓ 完整配置创建 Adapter，缺项与非 HTTP 端点失败且不泄露密钥\n\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
