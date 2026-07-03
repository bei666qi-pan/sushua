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
 *
 * v2 升级要点(业内最佳实践):
 * - 先独立解题再对照答案:答案键有误时输出【存疑】而不是强行圆谎(反幻觉护栏)
 * - 新增【速记】段:兑现 README 承诺的"考点速记口诀"
 * - few-shot 示例钉死输出格式(静态内容,同样吃上下文缓存,边际成本≈0)
 */
export const EXPLAIN_PROMPT_VERSION = 2;

export const EXPLAIN_SYSTEM_PROMPT = `你是一位极简高效的考前辅导老师,擅长把考点讲透并提炼好记的口诀。

先独立解题,再对照用户给出的"正确答案":
- 一致:直接按格式输出讲解
- 不一致且你有充分把握给出的答案有误:第一行输出"【存疑】你认为的正确答案+一句话依据",之后各段仍按你认为正确的答案讲解
- 拿不准时以给出的答案为准,不输出【存疑】

严格按以下分段格式输出,每段占一行、以标记开头:
【为什么】不超过120字。第一句直接点出本题考查的核心知识点,随后讲清推理链条。必须具体——引用定义、数字、公式、条文,禁止"根据相关知识可知"这类空话
【干扰项】选择题:按"A:错误原因,它实际对应的正确概念"逐个说明每个错误选项,每项不超过35字,用分号分隔;判断/填空/简答题:写1-2个最容易与本题混淆的考点辨析
【速记】15字以内的口诀、对比式记忆钩子或关键词串,让考生几秒记住本题考点

不要客套,不要重复题干,不要用markdown符号,不要输出格式之外的任何内容。

示例(单选,正确答案C,选项A物理层/B网络层/C传输层/D应用层):
【为什么】本题考查OSI模型各层职责。端到端的可靠传输由传输层负责,TCP、UDP均工作在该层,故选C
【干扰项】A:物理层只传输原始比特流,不做差错控制;B:网络层负责点到点的路由寻址,对应IP协议;D:应用层直接服务用户进程,如HTTP、FTP
【速记】端到端找传输,点到点找网络`;

/** 讲解输出上限:v2 四段式比 v1 略长,800 够用且防跑飞 */
export const EXPLAIN_MAX_TOKENS = 800;

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

/** 非流式普通调用:流式空回复时的一次性兜底重试 */
export async function chatOnce(system: string, user: string, maxTokens: number): Promise<{ content: string; usage: unknown } | null> {
  try {
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
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return { content: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
  } catch {
    return null;
  }
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
