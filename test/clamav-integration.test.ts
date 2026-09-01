import assert from "node:assert/strict";

import { createClamAvAdapter } from "../src/features/security/clamav-adapter";

const host = requiredEnvironment("TEST_CLAMAV_HOST");
const port = Number(process.env.TEST_CLAMAV_PORT);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("TEST_CLAMAV_PORT must be a valid TCP port for the real ClamAV integration test");
}

async function main() {
  console.log("Real ClamAV INSTREAM Integration");
  const scanner = createClamAvAdapter({ host, port, timeoutMs: 30_000 });

  assert.deepEqual(
    await scanner.scan(bytes("SuShua integration test"), { maxBytes: 23 }),
    { status: "clean" },
  );
  console.log("  ✓ 真实 clamd 将普通字节流判定为 clean");

  const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
  const result = await scanner.scan(bytes(eicar), { maxBytes: 68 });
  assert.equal(result.status, "infected");
  assert.match(result.signature, /EICAR/i);
  console.log("  ✓ 真实 clamd 将标准 EICAR 判定为 infected，并返回病毒签名");

  console.log("\n全部通过 ✓");
}

function bytes(value: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(value);
    },
  };
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the real ClamAV integration test`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
