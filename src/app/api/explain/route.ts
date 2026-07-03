import { getCachedExplanation, saveExplanation } from "@/lib/db";
import { questionHash } from "@/lib/hash";
import { aiConfigured, budgetState, chatOnce, chatStreamRaw, recordUsage, EXPLAIN_MAX_TOKENS, EXPLAIN_PROMPT_VERSION, EXPLAIN_SYSTEM_PROMPT } from "@/lib/deepseek";
import { allow, clientIp } from "@/lib/ratelimit";
import { TYPE_LABEL, type QType } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

function sseResponse(cb: (send: (obj: unknown) => void) => Promise<void>): Response {
  const stream = new ReadableStream({
    async start(controller) {
      // 客户端断开后 enqueue 会抛错;吞掉它继续跑完 cb,
      // 保证已付费的上游输出仍然写入全局缓存
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sse(obj));
        } catch {
          closed = true;
        }
      };
      try {
        await cb(send);
      } catch {
        send({ t: "error", code: "internal", msg: "解析服务出错,请稍后再试" });
      }
      if (!closed) {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(req: Request) {
  let body: { stem?: string; options?: string[]; answer?: string; type?: QType; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const stem = String(body.stem ?? "").trim().slice(0, 4000);
  const options = (Array.isArray(body.options) ? body.options : []).map(String).slice(0, 8);
  const answer = String(body.answer ?? "").slice(0, 2000);
  const type = body.type ?? "single";
  const force = body.force === true;
  if (!stem) return new Response("bad request", { status: 400 });

  const hash = questionHash(stem, options);

  // 1) 全局缓存命中:同一题全站只调一次 API,直接读库返回。
  //    force=true(用户点"重新生成")跳过读缓存,用新版 prompt 重生成并覆盖旧缓存
  const cached = getCachedExplanation(hash);
  if (cached && !force) {
    return sseResponse(async (send) => {
      send({ t: "meta", cached: true, v: cached.version });
      send({ t: "delta", c: cached.content });
      send({ t: "done" });
    });
  }

  // 2) 小时熔断:≥9.5 元只回缓存
  if (budgetState().broken) {
    return sseResponse(async (send) => {
      send({ t: "error", code: "breaker", msg: "本小时 AI 名额已满,缓存解析仍可用,请下个小时再试" });
    });
  }

  // 3) IP 限流:10 次/分钟;强制重生成必然打 API,单独更严限流 3 次/分钟
  const ip = clientIp(req);
  if (!allow("explain:" + ip, 10, 60_000) || (force && !allow("explain-force:" + ip, 3, 60_000))) {
    return sseResponse(async (send) => {
      send({ t: "error", code: "ratelimit", msg: "请求太频繁,休息一下,一分钟后再试" });
    });
  }

  if (!aiConfigured()) {
    return sseResponse(async (send) => {
      send({ t: "error", code: "no_ai", msg: "AI 服务未配置" });
    });
  }

  const userPrompt = [
    `题型:${TYPE_LABEL[type] ?? "未知"}`,
    `题目:${stem}`,
    options.length ? `选项:\n${options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n")}` : "",
    `正确答案:${answer || "(未提供)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return sseResponse(async (send) => {
    send({ t: "meta", cached: false, v: EXPLAIN_PROMPT_VERSION });
    const upstream = await chatStreamRaw(EXPLAIN_SYSTEM_PROMPT, userPrompt, EXPLAIN_MAX_TOKENS);
    if (!upstream.ok || !upstream.body) {
      send({ t: "error", code: "upstream", msg: "AI 服务暂时不可用,请稍后再试" });
      return;
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let usage: unknown = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        for (const line of ev.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const delta: string = json.choices?.[0]?.delta?.content ?? "";
            if (delta) {
              full += delta;
              send({ t: "delta", c: delta });
            }
            if (json.usage) usage = json.usage;
          } catch {}
        }
      }
    }
    // 按实际 usage 入账小时预算
    let tokensIn = 0;
    let tokensOut = 0;
    if (usage) {
      const { tokens } = recordUsage(usage);
      tokensIn = tokens.missTokens + tokens.hitTokens;
      tokensOut = tokens.outputTokens;
    }

    // 流式空回复:非流式兜底重试一次(偶发上游异常,避免让用户手动重试)
    if (!full.trim()) {
      const retry = await chatOnce(EXPLAIN_SYSTEM_PROMPT, userPrompt, EXPLAIN_MAX_TOKENS);
      if (retry?.content.trim()) {
        full = retry.content;
        send({ t: "delta", c: full });
        if (retry.usage) {
          const { tokens } = recordUsage(retry.usage);
          tokensIn += tokens.missTokens + tokens.hitTokens;
          tokensOut += tokens.outputTokens;
        }
      }
    }

    if (full.trim()) {
      saveExplanation(hash, full, tokensIn, tokensOut, EXPLAIN_PROMPT_VERSION);
      send({ t: "done" });
    } else {
      send({ t: "error", code: "empty", msg: "AI 没有返回内容,请重试" });
    }
  });
}
