import assert from "node:assert/strict";
import { v7 as uuidv7 } from "uuid";

async function main() {
  const readerModule = await import("../src/features/storage/s3-source-object-reader").catch(() => null);
  assert.ok(readerModule, "S3 SourceObjectReader must exist");
  const workspaceId = uuidv7();
  const key = `tenant/${workspaceId}/documents/source/object.pdf`;
  let commandName = "";
  const reader = readerModule.createS3SourceObjectReader({
    bucket: "sushua-private",
    client: {
      async send(command: object) {
        commandName = command.constructor.name;
        return { Body: chunks(Buffer.from("source "), Buffer.from("bytes")) };
      },
    },
  });

  console.log("S3 SourceObjectReader");
  const body = await reader.read({ key }, new AbortController().signal);
  const received: Buffer[] = [];
  for await (const chunk of body) received.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(received).toString(), "source bytes");
  assert.equal(commandName, "GetObjectCommand");
  console.log("  ✓ 使用 GetObject 流式返回真实字节，不生成浏览器预签名 URL");

  const malformed = readerModule.createS3SourceObjectReader({
    bucket: "sushua-private",
    client: { send: async () => ({ Body: "not-a-stream" }) },
  });
  await assert.rejects(
    () => malformed.read({ key }, new AbortController().signal),
    /invalid_storage_object_body/,
  );
  console.log("  ✓ S3 非流式或缺失 Body 失败关闭");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => reader.read({ key }, controller.signal), /storage_read_aborted/);
  await assert.rejects(
    () => reader.read({ key: `tenant/${workspaceId}/../escape` }, new AbortController().signal),
    /invalid_storage_object_key/,
  );
  console.log("  ✓ 取消与路径逃逸在读取前被拒绝");
  console.log("\n全部通过 ✓");
}

function chunks(...values: Buffer[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
