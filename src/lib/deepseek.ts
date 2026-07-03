import { addUsage, hourCostFen } from "./db";
import { costFen, isBroken, isPeakHour, shanghaiHourParts, usageFromApi, type UsageTokens } from "./pricing";

const BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

export function aiConfigured(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

export function modelName(): string {
  return MODEL;
}

/**
 * 全站统一固定 system prompt 前缀:吃 DeepSeek 上下文缓存(0.02 元/M)。
 * 不要在 system prompt 里拼接任何动态内容。
 */
export const EXPLAIN_SYSTEM_PROMPT =
  "你是一位极简高效的考前辅导老师。针对给出的题目和正确答案,严格按下面两段格式输出,每段占一行、以标记开头:\n【为什么】不超过100字。第一句直接点出答案对应的核心知识点,后面讲清推理依据。要具体(引用概念、数字、条文),不要空话套话\n【干扰项】选择题按\"A:错在哪\"逐个说明错误选项,指出它对应的正确概念是什么(每项不超过30字,用分号分隔);判断/填空/简答题则写1-2个最容易混淆的考点辨析\n不要输出任何其他内容,不要客套,不要重复题干,不要用markdown符号。";

export const EXTRACT_SYSTEM_PROMPT =
  '你是题库结构化抽取器。把用户给出的原始文本切分成题目,输出 JSON:{"questions":[{"type":"single|multiple|judge|fill|short","stem":"题干","options":["选项内容,不带字母前缀"],"answer":"单选如A/多选如ABD/判断为对或错/填空简答为文本","explanation":"解析,没有则为空串"}]}。只输出 JSON。无法识别为题目的内容忽略。';

/** 当前小时预算状态 */
export function budgetState() {
  const { hour, bucket } = shanghaiHourParts(new Date());
  const { costFen: spent, calls } = hourCostFen(bucket);
  return { bucket, hour, peak: isPeakHour(hour), spentFen: spent, calls, broken: isBroken(spent) };
}

/** 按实际 usage 计费入账,返回本次成本(分) */
export function recordUsage(usage: unknown): { fen: number; tokens: UsageTokens } {
  const { hour, bucket } = shanghaiHourParts(new Date());
  const tokens = usageFromApi(usage);
  const fen = costFen(tokens, isPeakHour(hour));
  addUsage(bucket, fen);
  return { fen, tokens };
}

/** 非流式 JSON mode 调用(题库抽取兜底用) */
export async function chatJSON(system: string, user: string, maxTokens: number): Promise<{ content: string; usage: unknown } | null> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { content: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
}

/** 流式调用,返回原始 SSE 响应体(由路由层解析转发) */
export async function chatStreamRaw(system: string, user: string, maxTokens: number): Promise<Response> {
  return fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(90_000),
  });
}
