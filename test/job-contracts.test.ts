import assert from "node:assert/strict";
import { v7 as uuidv7 } from "uuid";

async function main() {
  const contracts = await import("@sushua/job-contracts").catch(() => null);
  assert.ok(contracts, "job contracts workspace package must exist");
  assert.equal(typeof contracts.parseJobEnvelope, "function");

  const input = {
    schemaVersion: 1,
    id: uuidv7(),
    type: "document.parse",
    workspaceId: uuidv7(),
    learnerId: uuidv7(),
    resourceId: uuidv7(),
    idempotencyKey: "parse:document-v1",
    traceId: uuidv7(),
    requestedAt: "2026-09-01T00:00:00.000Z",
    priority: 3,
    budget: { maxCostFen: 120, maxTokens: 5000 },
    checkpoint: { page: 3, phase: "extract" },
  };

  console.log("Job Envelope v1");
  const parsed = contracts.parseJobEnvelope(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.budget), true);
  assert.equal(Object.isFrozen(parsed.checkpoint), true);
  console.log("  ✓ 严格解析跨服务 Envelope，并返回不可变副本");

  for (const [label, candidate, error] of [
    ["未知 schema", { ...input, schemaVersion: 2 }, /invalid_job_schema_version/],
    ["未知任务类型", { ...input, type: "presentation.generate" }, /invalid_job_type/],
    ["非 UUIDv7 job id", { ...input, id: "00000000-0000-4000-8000-000000000000" }, /invalid_job_id/],
    ["空幂等键", { ...input, idempotencyKey: "" }, /invalid_job_idempotency_key/],
    ["负预算", { ...input, budget: { maxCostFen: -1 } }, /invalid_job_budget/],
    ["数组 checkpoint", { ...input, checkpoint: ["page", 3] }, /invalid_job_checkpoint/],
    ["额外字段", { ...input, sourceText: "private content" }, /invalid_job_envelope_fields/],
  ] as const) {
    assert.throws(() => contracts.parseJobEnvelope(candidate), error, label);
  }
  console.log("  ✓ 未知版本/类型、错误 ID、非法预算、数组 checkpoint 和额外私密字段均失败关闭");

  const withoutOptional = { ...input } as Record<string, unknown>;
  delete withoutOptional.learnerId;
  delete withoutOptional.checkpoint;
  delete (withoutOptional.budget as Record<string, unknown>).maxCostFen;
  assert.deepEqual(contracts.parseJobEnvelope(withoutOptional), withoutOptional);
  console.log("  ✓ 可选 Learner、checkpoint 和单项预算保持协议兼容");

  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
