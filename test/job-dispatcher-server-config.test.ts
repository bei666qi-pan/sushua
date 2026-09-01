import assert from "node:assert/strict";

async function main() {
  const serverModule = await import("../src/features/jobs/dispatcher-server").catch(() => null);
  assert.ok(serverModule, "Job Dispatcher server assembly must exist");
  const redisUrl = "redis://integration-user:integration-secret@redis.internal:6379/2";
  let received: { queueName: string; redisUrl: string } | undefined;
  const dispatcher = serverModule.createJobDispatcherFromEnvironment({ REDIS_URL: redisUrl }, (input) => {
    received = input;
    return { dispatch: async () => undefined, close: async () => undefined };
  });
  assert.equal(typeof dispatcher.dispatch, "function");
  assert.equal(typeof dispatcher.close, "function");
  assert.deepEqual(received, { queueName: "sushua-document", redisUrl });
  assert.throws(
    () => serverModule.createJobDispatcherFromEnvironment({}),
    (error: unknown) => error instanceof Error
      && error.message === "missing_job_dispatch_config:REDIS_URL"
      && !error.message.includes("integration-secret"),
  );
  assert.throws(
    () => serverModule.createJobDispatcherFromEnvironment({ REDIS_URL: "https://integration-secret@example.test" }),
    (error: unknown) => error instanceof Error
      && error.message === "invalid_redis_url"
      && !error.message.includes("integration-secret"),
  );
  console.log("Job Dispatcher 环境装配\n  ✓ 完整 Redis 配置创建 Dispatcher，缺项和非法协议失败且不泄露密钥\n\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
