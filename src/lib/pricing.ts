/**
 * AI 成本核算与小时熔断(纯函数,便于单测)。
 * 计价单位:分(fen)。DeepSeek 定价(非峰时):
 *   输入未命中 1 元/M tokens = 100 分/M
 *   输入缓存命中 0.02 元/M = 2 分/M
 *   输出 2 元/M = 200 分/M
 * 峰时(北京时间 9:00–12:00、14:00–18:00)按 2 倍计。
 */

export const HOUR_BUDGET_FEN = 1000; // 硬性预算:10 元/小时
export const BREAKER_FEN = 950; // 累计 ≥9.5 元触发熔断,只回缓存

export interface UsageTokens {
  missTokens: number; // 输入未命中
  hitTokens: number; // 输入缓存命中
  outputTokens: number;
}

/** 北京时间的小时数(0-23)与小时桶 "YYYY-MM-DD-HH" */
export function shanghaiHourParts(d: Date): { hour: number; bucket: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // en-CA 的 24 小时制会把 0 点格式化为 "24",归一化
  const hour = Number(get("hour")) % 24;
  return {
    hour,
    bucket: `${get("year")}-${get("month")}-${get("day")}-${String(hour).padStart(2, "0")}`,
  };
}

/** 峰时:9:00–12:00、14:00–18:00(北京时间) */
export function isPeakHour(hour: number): boolean {
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 单次调用成本(分),峰时 2 倍 */
export function costFen(u: UsageTokens, peak: boolean): number {
  const base =
    (u.missTokens / 1e6) * 100 +
    (u.hitTokens / 1e6) * 2 +
    (u.outputTokens / 1e6) * 200;
  return base * (peak ? 2 : 1);
}

/** 熔断判定:当前小时累计成本 ≥9.5 元(950 分)则只回缓存 */
export function isBroken(currentHourFen: number): boolean {
  return currentHourFen >= BREAKER_FEN;
}

/** 从 DeepSeek usage 对象提取三类 token 数(字段缺失时兜底) */
export function usageFromApi(usage: unknown): UsageTokens {
  const u = (usage ?? {}) as Record<string, number>;
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? Math.max((u.prompt_tokens ?? 0) - hit, 0);
  return { missTokens: miss, hitTokens: hit, outputTokens: u.completion_tokens ?? 0 };
}
