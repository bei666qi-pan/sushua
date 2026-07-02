import { NextResponse } from "next/server";
import { parseText, chunkTexts } from "@/lib/parser";
import { aiConfigured, budgetState, chatJSON, recordUsage, EXTRACT_SYSTEM_PROMPT } from "@/lib/deepseek";
import { allow, clientIp } from "@/lib/ratelimit";
import type { DraftQuestion } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_AI_CHUNKS = 3; // 单次上传最多兜底 3 块,控成本

async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  if (name.endsWith(".pdf")) {
    // pdf-parse 的包入口在直接 import 时有 debug 模式坑,用内部实现路径
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
    const out = await pdfParse(buf);
    return out.text ?? "";
  }
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const mammoth = await import("mammoth");
    const out = await mammoth.extractRawText({ buffer: buf });
    return out.value ?? "";
  }
  // txt:优先 utf-8,乱码率高时尝试 GBK
  let text = buf.toString("utf8");
  const badRatio = (text.match(/�/g)?.length ?? 0) / Math.max(text.length, 1);
  if (badRatio > 0.05) {
    try {
      text = new TextDecoder("gbk").decode(buf);
    } catch {}
  }
  return text;
}

interface AiExtracted { questions?: DraftQuestion[] }

export async function POST(req: Request) {
  let text = "";
  let filename = "";
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "缺少文件" }, { status: 400 });
      if (file.size > MAX_SIZE) return NextResponse.json({ error: "文件超过 20MB 限制" }, { status: 400 });
      const ok = /\.(pdf|docx?|txt)$/i.test(file.name);
      if (!ok) return NextResponse.json({ error: "仅支持 .pdf / .docx / .txt 文件" }, { status: 400 });
      filename = file.name.replace(/\.(pdf|docx?|txt)$/i, "");
      text = await extractTextFromFile(file);
    } else {
      const body = await req.json();
      text = String(body.text ?? "");
      filename = String(body.filename ?? "");
    }
  } catch (e) {
    return NextResponse.json({ error: "文件解析失败:" + (e instanceof Error ? e.message : "未知错误") }, { status: 422 });
  }

  if (!text.trim()) return NextResponse.json({ error: "未能从文件中提取到文字内容(扫描版 PDF 暂不支持)" }, { status: 422 });
  if (text.length > 2_000_000) text = text.slice(0, 2_000_000);

  // 第一步:规则切题(零成本)
  const { questions, leftovers } = parseText(text);

  // 第二步:低置信度段落 AI 兜底(受预算熔断 + IP 限流约束)
  let aiUsed = false;
  let aiSkipReason = "";
  if (leftovers.length > 0 && questions.length < 500) {
    if (!aiConfigured()) {
      aiSkipReason = "ai_not_configured";
    } else if (budgetState().broken) {
      aiSkipReason = "budget_breaker";
    } else if (!allow("parse:" + clientIp(req), 5, 3600_000)) {
      aiSkipReason = "rate_limited";
    } else {
      const chunks = chunkTexts(leftovers).slice(0, MAX_AI_CHUNKS);
      const seen = new Set(questions.map((q) => q.stem.replace(/\s/g, "").slice(0, 60)));
      for (const chunk of chunks) {
        if (budgetState().broken) break;
        try {
          const res = await chatJSON(EXTRACT_SYSTEM_PROMPT, chunk, 2000);
          if (!res) continue;
          recordUsage(res.usage);
          const parsed = JSON.parse(res.content) as AiExtracted;
          for (const q of parsed.questions ?? []) {
            if (!q?.stem?.trim()) continue;
            const key = q.stem.replace(/\s/g, "").slice(0, 60);
            if (seen.has(key)) continue; // 规则已切出的题不重复
            seen.add(key);
            questions.push({
              type: ["single", "multiple", "judge", "fill", "short"].includes(q.type) ? q.type : "short",
              stem: String(q.stem).trim(),
              options: Array.isArray(q.options) ? q.options.map(String) : [],
              answer: String(q.answer ?? ""),
              explanation: q.explanation ? String(q.explanation) : undefined,
            });
            aiUsed = true;
          }
        } catch {
          // 单块失败不影响整体
        }
      }
    }
  }

  return NextResponse.json({
    filename,
    questions,
    stats: { total: questions.length, aiUsed, aiSkipReason, leftoverCount: leftovers.length },
  });
}
