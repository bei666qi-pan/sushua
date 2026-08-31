import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { BetterAuthOptions, DBAdapter, DBAdapterInstance, Where } from "better-auth";
import { withHashedSessionTokens } from "../src/features/auth/session-token-adapter";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const rows = new Map<string, Record<string, unknown>>();
  const observed: Array<{ operation: string; where?: Where[]; data?: Record<string, unknown> }> = [];
  const baseFactory: DBAdapterInstance = (() => {
    const adapter: DBAdapter = {
      id: "fake",
      async create(input) {
        observed.push({ operation: "create", data: input.data });
        const row = { id: "session-id", ...input.data };
        rows.set(String(row.token), row);
        return row as never;
      },
      async findOne(input) {
        observed.push({ operation: "findOne", where: input.where });
        const token = input.where.find((item) => item.field === "token")?.value;
        return (typeof token === "string" ? rows.get(token) : undefined) as never ?? null;
      },
      async findMany(input) {
        observed.push({ operation: "findMany", where: input.where });
        const tokenWhere = input.where?.find((item) => item.field === "token");
        if (!tokenWhere) return [...rows.values()] as never;
        const tokens = Array.isArray(tokenWhere.value) ? tokenWhere.value : [tokenWhere.value];
        return tokens.flatMap((token) => typeof token === "string" && rows.has(token) ? [rows.get(token)!] : []) as never;
      },
      async update(input) {
        observed.push({ operation: "update", where: input.where, data: input.update });
        const token = input.where.find((item) => item.field === "token")?.value;
        if (typeof token !== "string" || !rows.has(token)) return null;
        const row = { ...rows.get(token), ...input.update };
        rows.set(token, row);
        return row as never;
      },
      async updateMany() { return 0; },
      async delete(input) {
        observed.push({ operation: "delete", where: input.where });
        const token = input.where.find((item) => item.field === "token")?.value;
        if (typeof token === "string") rows.delete(token);
      },
      async deleteMany() { return 0; },
      async consumeOne() { return null; },
      async incrementOne() { return null; },
      async count() { return rows.size; },
      async transaction(callback) { return callback(adapter); },
    };
    return adapter;
  }) as DBAdapterInstance;

  const adapter = withHashedSessionTokens(baseFactory)({} as BetterAuthOptions);
  const rawToken = "raw-session-token-that-stays-in-the-cookie";
  const tokenHash = sha256(rawToken);

  console.log("会话 token 哈希 Adapter");
  const created = await adapter.create<Record<string, unknown>>({
    model: "session",
    data: { token: rawToken, userId: "user-id" },
  });
  assert.equal(observed.at(-1)?.data?.token, tokenHash);
  assert.equal(created.token, rawToken);
  assert.equal(rows.has(rawToken), false);
  assert.equal(rows.has(tokenHash), true);
  console.log("  ✓ 数据库只接收 SHA256，创建结果仍返回原始 cookie token");

  const found = await adapter.findOne<Record<string, unknown>>({
    model: "session",
    where: [{ field: "token", value: rawToken }],
  });
  assert.equal(observed.at(-1)?.where?.[0]?.value, tokenHash);
  assert.equal(found?.token, rawToken);
  console.log("  ✓ 当前会话用原始 token 查询哈希行且不把哈希返回为凭证");

  const updated = await adapter.update<Record<string, unknown>>({
    model: "session",
    where: [{ field: "token", value: rawToken }],
    update: { userAgent: "test" },
  });
  assert.equal(observed.at(-1)?.where?.[0]?.value, tokenHash);
  assert.equal(updated?.token, rawToken);
  console.log("  ✓ 会话刷新沿用同一哈希边界");

  const listed = await adapter.findMany<Record<string, unknown>>({
    model: "session",
    where: [{ field: "token", value: [rawToken], operator: "in" }],
  });
  assert.equal(listed[0]?.token, rawToken);
  console.log("  ✓ 批量精确 token 查询保持原始 token 与哈希一一映射");

  const hashAsCredential = await adapter.findOne<Record<string, unknown>>({
    model: "session",
    where: [{ field: "token", value: tokenHash }],
  });
  assert.equal(hashAsCredential, null);
  assert.equal(observed.at(-1)?.where?.[0]?.value, sha256(tokenHash));
  console.log("  ✓ 数据库哈希本身不能作为 cookie 凭证使用");

  await adapter.delete({ model: "session", where: [{ field: "token", value: rawToken }] });
  assert.equal(observed.at(-1)?.where?.[0]?.value, tokenHash);
  assert.equal(rows.size, 0);
  console.log("  ✓ 登出按哈希删除会话");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
