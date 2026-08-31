import { createHash } from "node:crypto";
import type {
  BetterAuthOptions,
  DBAdapter,
  DBAdapterInstance,
  DBTransactionAdapter,
  Where,
} from "better-auth";

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function transformWhere(model: string, where: Where[] | undefined) {
  const rawByHash = new Map<string, string>();
  if (model !== "session" || !where) return { where, rawByHash };

  const transformed = where.map((condition) => {
    if (condition.field !== "token") return condition;
    if (Array.isArray(condition.value)) {
      if (!condition.value.every((value): value is string => typeof value === "string")) return condition;
      return {
        ...condition,
        value: condition.value.map((value) => {
          const hash = hashSessionToken(value);
          rawByHash.set(hash, value);
          return hash;
        }),
      };
    }
    if (typeof condition.value !== "string") return condition;
    const hash = hashSessionToken(condition.value);
    rawByHash.set(hash, condition.value);
    return { ...condition, value: hash };
  });
  return { where: transformed, rawByHash };
}

function transformSessionData(model: string, data: Record<string, unknown>) {
  if (model !== "session" || typeof data.token !== "string") {
    return { data, rawByHash: new Map<string, string>() };
  }
  const hash = hashSessionToken(data.token);
  return {
    data: { ...data, token: hash },
    rawByHash: new Map([[hash, data.token]]),
  };
}

function restoreSessionToken<T>(model: string, value: T, rawByHash: Map<string, string>): T {
  if (model !== "session" || !value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const rawToken = typeof record.token === "string" ? rawByHash.get(record.token) : undefined;
  return (rawToken ? { ...record, token: rawToken } : value) as T;
}

function mergeMaps(...maps: Map<string, string>[]) {
  return new Map(maps.flatMap((map) => [...map.entries()]));
}

function wrapTransactionAdapter(base: DBTransactionAdapter): DBTransactionAdapter {
  return createWrappedOperations(base);
}

function createWrappedOperations<T extends DBTransactionAdapter>(base: T): T {
  return {
    ...base,
    async create(input) {
      const transformed = transformSessionData(input.model, input.data);
      const created = await base.create({ ...input, data: transformed.data });
      return restoreSessionToken(input.model, created, transformed.rawByHash);
    },
    async findOne(input) {
      const transformed = transformWhere(input.model, input.where);
      const found = await base.findOne({ ...input, where: transformed.where ?? [] });
      return restoreSessionToken(input.model, found, transformed.rawByHash);
    },
    async findMany(input) {
      const transformed = transformWhere(input.model, input.where);
      const found = await base.findMany({ ...input, where: transformed.where });
      return found.map((row) => restoreSessionToken(input.model, row, transformed.rawByHash));
    },
    async count(input) {
      const transformed = transformWhere(input.model, input.where);
      return base.count({ ...input, where: transformed.where });
    },
    async update(input) {
      const transformedWhere = transformWhere(input.model, input.where);
      const transformedData = transformSessionData(input.model, input.update);
      const updated = await base.update({
        ...input,
        where: transformedWhere.where ?? [],
        update: transformedData.data,
      });
      return restoreSessionToken(
        input.model,
        updated,
        mergeMaps(transformedWhere.rawByHash, transformedData.rawByHash),
      );
    },
    async updateMany(input) {
      const transformedWhere = transformWhere(input.model, input.where);
      const transformedData = transformSessionData(input.model, input.update);
      return base.updateMany({
        ...input,
        where: transformedWhere.where ?? [],
        update: transformedData.data,
      });
    },
    async delete(input) {
      const transformed = transformWhere(input.model, input.where);
      return base.delete({ ...input, where: transformed.where ?? [] });
    },
    async deleteMany(input) {
      const transformed = transformWhere(input.model, input.where);
      return base.deleteMany({ ...input, where: transformed.where ?? [] });
    },
    async consumeOne(input) {
      const transformed = transformWhere(input.model, input.where);
      const consumed = await base.consumeOne({ ...input, where: transformed.where ?? [] });
      return restoreSessionToken(input.model, consumed, transformed.rawByHash);
    },
    async incrementOne(input) {
      const transformed = transformWhere(input.model, input.where);
      const transformedSet = input.set ? transformSessionData(input.model, input.set) : undefined;
      const updated = await base.incrementOne({
        ...input,
        where: transformed.where ?? [],
        set: transformedSet?.data,
      });
      return restoreSessionToken(
        input.model,
        updated,
        mergeMaps(transformed.rawByHash, transformedSet?.rawByHash ?? new Map()),
      );
    },
  } as T;
}

function wrapAdapter(base: DBAdapter): DBAdapter {
  const operations = createWrappedOperations(base);
  return {
    ...operations,
    transaction: (callback) => base.transaction((transaction) => callback(wrapTransactionAdapter(transaction))),
  };
}

export function withHashedSessionTokens(factory: DBAdapterInstance): DBAdapterInstance {
  return (options: BetterAuthOptions) => wrapAdapter(factory(options));
}
