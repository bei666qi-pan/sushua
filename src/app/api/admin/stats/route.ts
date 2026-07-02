import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getDb } from "@/lib/db";
import { budgetState, aiConfigured, modelName } from "@/lib/deepseek";
import { HOUR_BUDGET_FEN, BREAKER_FEN } from "@/lib/pricing";

export const dynamic = "force-dynamic";

/** 观测后台专用统计接口:仅持 ADMIN_TOKEN 者可读(shuahoutai 服务端代理调用) */
export async function GET(req: Request) {
  const token = process.env.ADMIN_TOKEN ?? "";
  const given = req.headers.get("x-admin-token") ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(given);
  if (!token || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const one = <T>(sql: string) => db.prepare(sql).get() as T;
  const all = <T>(sql: string) => db.prepare(sql).all() as T[];

  const banksByVis = all<{ visibility: string; c: number }>(
    "SELECT visibility, COUNT(*) AS c FROM banks GROUP BY visibility"
  );
  const totals = {
    banks: one<{ c: number }>("SELECT COUNT(*) AS c FROM banks").c,
    questions: one<{ c: number }>("SELECT COUNT(*) AS c FROM questions").c,
    explanations: one<{ c: number }>("SELECT COUNT(*) AS c FROM ai_explanations").c,
    tokensIn: one<{ s: number | null }>("SELECT SUM(tokens_in) AS s FROM ai_explanations").s ?? 0,
    tokensOut: one<{ s: number | null }>("SELECT SUM(tokens_out) AS s FROM ai_explanations").s ?? 0,
  };
  const recentBanks = all<{
    slug: string; title: string; visibility: string; created_at: string; question_count: number;
  }>(
    `SELECT b.slug, b.title, b.visibility, b.created_at,
            (SELECT COUNT(*) FROM questions q WHERE q.bank_id = b.id) AS question_count
     FROM banks b ORDER BY b.id DESC LIMIT 20`
  );
  const usage = all<{ hour_bucket: string; cost_fen: number; calls: number }>(
    "SELECT hour_bucket, cost_fen, calls FROM usage_log ORDER BY hour_bucket DESC LIMIT 72"
  );
  const totalUsage = one<{ fen: number | null; calls: number | null }>(
    "SELECT SUM(cost_fen) AS fen, SUM(calls) AS calls FROM usage_log"
  );
  const budget = budgetState();

  return NextResponse.json({
    time: new Date().toISOString(),
    ai: { configured: aiConfigured(), model: modelName() },
    budget: {
      hourBucket: budget.bucket,
      peak: budget.peak,
      spentFen: budget.spentFen,
      calls: budget.calls,
      breaker: budget.broken,
      budgetFen: HOUR_BUDGET_FEN,
      breakerFen: BREAKER_FEN,
    },
    totals: {
      ...totals,
      costFenAllTime: totalUsage.fen ?? 0,
      callsAllTime: totalUsage.calls ?? 0,
    },
    banksByVisibility: Object.fromEntries(banksByVis.map((r) => [r.visibility, r.c])),
    recentBanks,
    usageByHour: usage,
  });
}
