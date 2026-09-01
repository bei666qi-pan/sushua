import assert from "node:assert/strict";

async function main() {
  const configModule = await import("../apps/job-worker/src/config").catch(() => null);
  assert.ok(configModule, "job-worker config module must exist");
  const environment = {
    DATABASE_URL: "postgresql://worker:private-db@postgres/sushua",
    REDIS_URL: "redis://:private-redis@redis:6379/0",
    STORAGE_DRIVER: "s3",
    S3_REGION: "cn-beijing",
    S3_BUCKET: "sushua-private",
    S3_ENDPOINT: "https://s3.example.test",
    S3_ACCESS_KEY_ID: "access-id",
    S3_SECRET_ACCESS_KEY: "private-s3",
    CLAMAV_HOST: "clamav",
    CLAMAV_PORT: "3310",
    DOCUMENT_SERVICE_URL: "http://document-worker:8000",
    DOCUMENT_SERVICE_TOKEN: "document-service-private-token-0001",
    WORKER_QUEUES: "document",
    WORKER_CONCURRENCY: "2",
    WORKER_LEASE_SECONDS: "300",
  };
  console.log("Job Worker 配置");
  assert.deepEqual(configModule.readJobWorkerConfig(environment), {
    databaseUrl: environment.DATABASE_URL,
    redisUrl: environment.REDIS_URL,
    queueName: "sushua-document",
    concurrency: 2,
    leaseSeconds: 300,
    clamav: { host: "clamav", port: 3310 },
    documentService: {
      baseUrl: "http://document-worker:8000",
      token: "document-service-private-token-0001",
    },
    s3: {
      bucket: "sushua-private",
      clientConfig: {
        region: "cn-beijing",
        endpoint: "https://s3.example.test",
        forcePathStyle: true,
        credentials: { accessKeyId: "access-id", secretAccessKey: "private-s3" },
      },
    },
  });
  console.log("  ✓ 完整配置收口为 document Worker 与私有服务参数");

  for (const patch of [
    { CLAMAV_PORT: "0" },
    { WORKER_CONCURRENCY: "101" },
    { WORKER_LEASE_SECONDS: "0" },
    { WORKER_QUEUES: "ai" },
    { STORAGE_DRIVER: "memory" },
    { DOCUMENT_SERVICE_URL: "ftp://document-worker" },
    { DOCUMENT_SERVICE_TOKEN: "short" },
    { DATABASE_URL: "" },
  ]) {
    const candidate = { ...environment, ...patch };
    assert.throws(
      () => configModule.readJobWorkerConfig(candidate),
      (error: unknown) => error instanceof Error
        && !error.message.includes("private-db")
        && !error.message.includes("private-redis")
        && !error.message.includes("private-s3"),
    );
  }
  console.log("  ✓ 缺失、越界和未实现队列均失败关闭且不泄露密钥");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
