import assert from "node:assert/strict";

async function main() {
  const storageModule = await import("../src/features/storage/storage").catch(() => null);
  const s3Module = await import("../src/features/storage/s3-storage-adapter").catch(() => null);
  assert.ok(storageModule && s3Module, "Storage interface and both Adapters must exist");

  console.log("Storage Adapter contract");
  const memory = storageModule.createMemoryStorageAdapter({
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  const intent = {
    ref: { key: "tenant/0199aa99-1111-7111-8111-111111111111/document/version/source/asset" },
    mimeType: "application/pdf",
    sizeBytes: 11 * 1024 * 1024,
    sha256: "a".repeat(64),
  };
  const memoryPlan = await memory.createUpload(intent);
  assert.equal(memoryPlan.parts.length, 3);
  assert.deepEqual(memoryPlan.parts.map((part: { partNumber: number }) => part.partNumber), [1, 2, 3]);
  assert.equal(memoryPlan.partSizeBytes, 5 * 1024 * 1024);
  assert.equal(memoryPlan.expiresAt, "2026-09-01T12:05:00.000Z");
  const memoryObject = await memory.completeUpload({
    ref: intent.ref,
    uploadId: memoryPlan.uploadId,
    parts: [
      { partNumber: 1, etag: '"part-1"' },
      { partNumber: 2, etag: '"part-2"' },
      { partNumber: 3, etag: '"part-3"' },
    ],
  });
  assert.deepEqual(memoryObject, {
    ref: intent.ref,
    sizeBytes: 11 * 1024 * 1024,
    sha256: "a".repeat(64),
    mimeType: "application/pdf",
    etag: '"memory-complete"',
  });
  assert.deepEqual(await memory.stat(intent.ref), memoryObject);
  assert.match(await memory.createReadUrl(intent.ref, 60), /^memory:\/\//);
  await memory.deleteMany([intent.ref]);
  await assert.rejects(() => memory.stat(intent.ref), /storage_object_not_found/);
  console.log("  ✓ 内存 Adapter 完整实现分片、完成、读取和删除生命周期");

  console.log("S3 multipart Adapter");
  const transport = new FakeS3Transport(intent.sizeBytes, intent.sha256, intent.mimeType);
  const s3 = s3Module.createS3StorageAdapter({
    bucket: "sushua-private",
    client: transport,
    presign: (client: unknown, command: unknown, options: { expiresIn: number }) =>
      transport.presign(client, command, options),
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  const plan = await s3.createUpload(intent);
  assert.equal(plan.uploadId, "upload-001");
  assert.equal(plan.parts.length, 3);
  assert.deepEqual(plan.parts.map((part: { partNumber: number; url: string }) => ({
    partNumber: part.partNumber,
    url: part.url,
  })), [
    { partNumber: 1, url: "https://s3.test/upload-001/1?expires=300" },
    { partNumber: 2, url: "https://s3.test/upload-001/2?expires=300" },
    { partNumber: 3, url: "https://s3.test/upload-001/3?expires=300" },
  ]);
  const completed = await s3.completeUpload({
    ref: intent.ref,
    uploadId: plan.uploadId,
    parts: [
      { partNumber: 3, etag: '"etag-3"' },
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ],
  });
  assert.deepEqual(transport.completedPartNumbers, [1, 2, 3]);
  assert.deepEqual(completed, {
    ref: intent.ref,
    sizeBytes: intent.sizeBytes,
    sha256: intent.sha256,
    mimeType: intent.mimeType,
    etag: '"s3-complete"',
  });
  assert.deepEqual(await s3.stat(intent.ref), completed);
  assert.equal(
    await s3.createReadUrl(intent.ref, 60),
    "https://s3.test/read?expires=60",
  );
  await s3.deleteMany([intent.ref]);
  assert.equal(transport.deleted, true);
  console.log("  ✓ S3 Adapter 生成 5 分钟预签名 URL，排序完成分片并校验对象元数据");

  await assert.rejects(
    () => s3.createUpload({ ...intent, ref: { key: "tenant/../escape" } }),
    /invalid_storage_object_key/,
  );
  await assert.rejects(
    () => s3.completeUpload({
      ref: intent.ref,
      uploadId: "upload-002",
      parts: [{ partNumber: 1, etag: '"one"' }, { partNumber: 1, etag: '"duplicate"' }],
    }),
    /invalid_storage_parts/,
  );
  console.log("  ✓ 路径穿越和重复/缺口分片在调用 S3 前失败关闭");

  const abortedPlan = await s3.createUpload({
    ...intent,
    ref: { key: "tenant/0199aa99-1111-7111-8111-111111111111/document/version/source/aborted" },
  });
  await s3.abortUpload({ ref: { key: "tenant/0199aa99-1111-7111-8111-111111111111/document/version/source/aborted" }, uploadId: abortedPlan.uploadId });
  assert.equal(transport.aborted, true);
  console.log("  ✓ 取消分片上传显式调用 S3 abort");

  const failingTransport = new FakeS3Transport(intent.sizeBytes, intent.sha256, intent.mimeType);
  failingTransport.failPresignPart = 2;
  const failingS3 = s3Module.createS3StorageAdapter({
    bucket: "sushua-private",
    client: failingTransport,
    presign: (client: unknown, command: unknown, options: { expiresIn: number }) =>
      failingTransport.presign(client, command, options),
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  await assert.rejects(() => failingS3.createUpload(intent), /test_presign_failed/);
  assert.equal(failingTransport.aborted, true);
  console.log("  ✓ 部分 URL 签名失败时自动 abort，不遗留孤儿 multipart upload");

  console.log("\n全部通过 ✓");
}

class FakeS3Transport {
  completedPartNumbers: number[] = [];
  deleted = false;
  aborted = false;
  failPresignPart?: number;
  private uploadCount = 0;

  constructor(
    private readonly sizeBytes: number,
    private readonly sha256: string,
    private readonly mimeType: string,
  ) {}

  async send(commandValue: unknown) {
    const command = storageCommand(commandValue);
    switch (command.name) {
      case "CreateMultipartUploadCommand":
        this.uploadCount += 1;
        return { UploadId: `upload-${String(this.uploadCount).padStart(3, "0")}` };
      case "CompleteMultipartUploadCommand":
        this.completedPartNumbers = ((command.input.MultipartUpload as { Parts: Array<{ PartNumber: number }> }).Parts)
          .map((part) => part.PartNumber);
        return { ETag: '"s3-complete"' };
      case "HeadObjectCommand":
        return {
          ContentLength: this.sizeBytes,
          ContentType: this.mimeType,
          Metadata: { sha256: this.sha256 },
          ETag: '"s3-complete"',
        };
      case "AbortMultipartUploadCommand":
        this.aborted = true;
        return {};
      case "DeleteObjectsCommand":
        this.deleted = true;
        return {};
      default:
        throw new Error(`unexpected_s3_command:${command.name}`);
    }
  }

  async presign(
    _client: unknown,
    commandValue: unknown,
    options: { expiresIn: number },
  ) {
    const command = storageCommand(commandValue);
    if (command.name === "UploadPartCommand") {
      if (command.input.PartNumber === this.failPresignPart) throw new Error("test_presign_failed");
      return `https://s3.test/${command.input.UploadId}/${command.input.PartNumber}?expires=${options.expiresIn}`;
    }
    if (command.name === "GetObjectCommand") {
      return `https://s3.test/read?expires=${options.expiresIn}`;
    }
    throw new Error(`unexpected_presign_command:${command.name}`);
  }
}

function storageCommand(value: unknown): { name: string; input: Record<string, unknown> } {
  if (!value || typeof value !== "object" || !("input" in value)) throw new Error("invalid_test_s3_command");
  const command = value as { constructor: { name?: unknown }; input: unknown };
  if (typeof command.constructor?.name !== "string" || !command.input || typeof command.input !== "object") {
    throw new Error("invalid_test_s3_command");
  }
  return { name: command.constructor.name, input: command.input as Record<string, unknown> };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
