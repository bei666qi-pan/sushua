import { createHash, randomBytes } from "crypto";

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** 32 位随机管理凭证 */
export const newOwnerKey = () => randomBytes(16).toString("hex");

export const newSlug = () => randomBytes(4).toString("hex");

/** 题目全局缓存键:sha256(题干+选项) */
export function questionHash(stem: string, options: string[]): string {
  return sha256(stem.trim() + "\n" + options.map((o) => o.trim()).join("\n"));
}
