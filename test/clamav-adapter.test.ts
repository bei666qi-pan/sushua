import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";

async function main() {
  const clamavModule = await import("../src/features/security/clamav-adapter");
  console.log("ClamAV INSTREAM Adapter");

  const clean = await withFakeClamAv(Buffer.from("stream: OK\0"), async ({ host, port, getReceived }) => {
    const scanner = clamavModule.createClamAvAdapter({ host, port, timeoutMs: 2_000 });
    const result = await scanner.scan(chunks("hello ", "world"), { maxBytes: 11 });
    assert.deepEqual(result, { status: "clean" });
    return getReceived();
  });
  assert.equal(clean.subarray(0, 10).toString(), "zINSTREAM\0");
  assert.equal(clean.readUInt32BE(10), 6);
  assert.equal(clean.subarray(14, 20).toString(), "hello ");
  assert.equal(clean.readUInt32BE(20), 5);
  assert.equal(clean.subarray(24, 29).toString(), "world");
  assert.equal(clean.readUInt32BE(29), 0);
  console.log("  ✓ 精确发送 zINSTREAM、big-endian 分帧和终止帧");

  await withFakeClamAv(Buffer.from("stream: Win.Test.EICAR_HDB-1 FOUND\0"), async ({ host, port }) => {
    const scanner = clamavModule.createClamAvAdapter({ host, port, timeoutMs: 2_000 });
    assert.deepEqual(await scanner.scan(chunks("eicar"), { maxBytes: 5 }), {
      status: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    });
  });
  console.log("  ✓ FOUND 响应返回受限病毒签名，不伪装 clean");

  await withFakeClamAv(Buffer.from("stream: temporary engine failure ERROR\0"), async ({ host, port }) => {
    const scanner = clamavModule.createClamAvAdapter({ host, port, timeoutMs: 2_000 });
    await assert.rejects(
      () => scanner.scan(chunks("data"), { maxBytes: 4 }),
      (error: unknown) => error instanceof clamavModule.ClamAvAdapterError
        && error.code === "clamav_scan_error"
        && error.retryable,
    );
  });
  await withFakeClamAv(Buffer.from("not-clamav\0"), async ({ host, port }) => {
    const scanner = clamavModule.createClamAvAdapter({ host, port, timeoutMs: 2_000 });
    await assert.rejects(
      () => scanner.scan(chunks("data"), { maxBytes: 4 }),
      (error: unknown) => error instanceof clamavModule.ClamAvAdapterError
        && error.code === "clamav_protocol_error"
        && !error.retryable,
    );
  });
  console.log("  ✓ ERROR 与畸形响应结构化失败，不能被当作 clean");

  const noServerPort = await unusedPort();
  const unavailable = clamavModule.createClamAvAdapter({ host: "127.0.0.1", port: noServerPort, timeoutMs: 200 });
  await assert.rejects(
    () => unavailable.scan(chunks("data"), { maxBytes: 4 }),
    (error: unknown) => error instanceof clamavModule.ClamAvAdapterError
      && error.code === "clamav_unavailable"
      && error.retryable
      && !error.message.includes("data"),
  );
  console.log("  ✓ 连接失败只返回安全可重试码，不泄露扫描内容");

  let bytesReceived = 0;
  await withFakeClamAv(Buffer.from("stream: OK\0"), async ({ host, port, getReceived }) => {
    const scanner = clamavModule.createClamAvAdapter({ host, port, timeoutMs: 2_000 });
    await assert.rejects(
      () => scanner.scan(chunks("1234", "5678"), { maxBytes: 7 }),
      (error: unknown) => error instanceof clamavModule.ClamAvAdapterError
        && error.code === "clamav_size_limit"
        && !error.retryable,
    );
    bytesReceived = getReceived().length;
  });
  assert.ok(bytesReceived < 10 + 4 + 4 + 4 + 4, "超限后不得继续发送剩余数据和 clean 终止帧");
  console.log("  ✓ 超过声明字节预算立即中止，不继续上传或接收伪 clean");

  assert.throws(() => clamavModule.createClamAvAdapter({ host: "https://clamav", port: 3310 }), /invalid_clamav_host/);
  assert.throws(() => clamavModule.createClamAvAdapter({ host: "localhost", port: 0 }), /invalid_clamav_port/);
  console.log("  ✓ 非主机配置和非法端口在联网前失败关闭");
  console.log("\n全部通过 ✓");
}

function chunks(...values: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield Buffer.from(value);
    },
  };
}

async function withFakeClamAv<T>(response: Buffer, operation: (input: {
  host: string;
  port: number;
  getReceived(): Buffer;
}) => Promise<T>): Promise<T> {
  let received = Buffer.alloc(0);
  let active: Socket | undefined;
  const server = createServer((socket) => {
    active = socket;
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (completeInstream(received)) socket.write(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await operation({
      host: "127.0.0.1",
      port: address.port,
      getReceived: () => received,
    });
  } finally {
    active?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function completeInstream(input: Buffer) {
  if (input.length < 14 || input.subarray(0, 10).toString() !== "zINSTREAM\0") return false;
  let offset = 10;
  while (offset + 4 <= input.length) {
    const length = input.readUInt32BE(offset);
    offset += 4;
    if (length === 0) return true;
    if (offset + length > input.length) return false;
    offset += length;
  }
  return false;
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
