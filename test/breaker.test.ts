/**
 * 小时熔断逻辑单测:注入假 usage,验证计价、峰时加倍、熔断阈值。
 * 运行:npm test(tsx test/breaker.test.ts),非零退出即失败。
 */
import {
  BREAKER_FEN,
  costFen,
  isBroken,
  isPeakHour,
  shanghaiHourParts,
  usageFromApi,
} from "../src/lib/pricing";

let failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

console.log("峰时判定(北京时间 9-12 / 14-18 双倍)");
assert("8 点非峰时", !isPeakHour(8));
assert("9 点峰时", isPeakHour(9));
assert("11 点峰时", isPeakHour(11));
assert("12 点非峰时", !isPeakHour(12));
assert("14 点峰时", isPeakHour(14));
assert("17 点峰时", isPeakHour(17));
assert("18 点非峰时", !isPeakHour(18));
assert("23 点非峰时", !isPeakHour(23));

console.log("计价:输入未命中 100 分/M、命中 2 分/M、输出 200 分/M");
{
  // 1M 未命中输入 + 1M 输出,非峰时 = 100 + 200 = 300 分
  const fen = costFen({ missTokens: 1_000_000, hitTokens: 0, outputTokens: 1_000_000 }, false);
  assert("1M 未命中 + 1M 输出 = 300 分", Math.abs(fen - 300) < 1e-9, `got ${fen}`);
}
{
  const fen = costFen({ missTokens: 0, hitTokens: 1_000_000, outputTokens: 0 }, false);
  assert("1M 缓存命中 = 2 分", Math.abs(fen - 2) < 1e-9, `got ${fen}`);
}
{
  const off = costFen({ missTokens: 500_000, hitTokens: 200_000, outputTokens: 100_000 }, false);
  const peak = costFen({ missTokens: 500_000, hitTokens: 200_000, outputTokens: 100_000 }, true);
  assert("峰时恰好 2 倍", Math.abs(peak - off * 2) < 1e-9, `off=${off} peak=${peak}`);
}
{
  // 典型单次解析:2000 输入未命中 + 500 输出,非峰 = 0.2 + 0.1 = 0.3 分
  const fen = costFen({ missTokens: 2000, hitTokens: 0, outputTokens: 500 }, false);
  assert("典型单次调用约 0.3 分", Math.abs(fen - 0.3) < 1e-9, `got ${fen}`);
}

console.log("假 usage 注入:DeepSeek usage 字段解析");
{
  const t = usageFromApi({ prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 700, completion_tokens: 450 });
  assert("命中/未命中/输出逐项解析", t.hitTokens === 300 && t.missTokens === 700 && t.outputTokens === 450);
}
{
  // 只有 prompt_tokens 时按未命中兜底
  const t = usageFromApi({ prompt_tokens: 1000, completion_tokens: 200 });
  assert("缺缓存字段时按 prompt_tokens 兜底", t.missTokens === 1000 && t.hitTokens === 0 && t.outputTokens === 200);
}
{
  const t = usageFromApi(undefined);
  assert("usage 缺失不崩", t.missTokens === 0 && t.hitTokens === 0 && t.outputTokens === 0);
}

console.log("小时熔断:累计 ≥9.5 元(950 分)只回缓存");
{
  assert("阈值为 950 分", BREAKER_FEN === 950);
  assert("949.9 分未熔断", !isBroken(949.9));
  assert("950 分触发熔断", isBroken(950));
  assert("超支也保持熔断", isBroken(1200));
}
{
  // 模拟一小时内连续调用累计:每次注入假 usage,直到熔断
  let spent = 0;
  let calls = 0;
  const fake = { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900_000, completion_tokens: 30_000 };
  while (!isBroken(spent) && calls < 100) {
    const t = usageFromApi(fake);
    spent += costFen(t, true); // 按峰时最贵路径累计:(0.9*100 + 0.03*200)*2 = 192 分/次
    calls++;
  }
  assert("连续注入假 usage 第 5 次后熔断", isBroken(spent) && calls === 5, `calls=${calls} spent=${spent}`);
  assert("熔断时累计已 ≥950 分", spent >= 950, `spent=${spent}`);
}

console.log("小时桶格式");
{
  const { bucket, hour } = shanghaiHourParts(new Date("2026-07-02T04:30:00Z")); // 北京时间 12:30
  assert("UTC 4:30 → 北京 12 点桶", hour === 12 && /^2026-07-02-12$/.test(bucket), `bucket=${bucket}`);
}
{
  const { hour } = shanghaiHourParts(new Date("2026-07-02T16:30:00Z")); // 北京时间次日 0:30
  assert("跨日 0 点小时归一化", hour === 0);
}

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log("\n全部通过 ✓");
