import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { aiConfigured, budgetState, modelName } from "@/lib/deepseek";
import { HOUR_BUDGET_FEN } from "@/lib/pricing";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  let bankCount = 0;
  try {
    bankCount = (getDb().prepare("SELECT COUNT(*) AS c FROM banks").get() as { c: number }).c;
    dbOk = true;
  } catch {}
  const budget = dbOk ? budgetState() : null;
  return NextResponse.json({
    ok: dbOk,
    version: process.env.APP_VERSION || "1.0.0",
    db: { ok: dbOk, banks: bankCount },
    ai: { configured: aiConfigured(), model: modelName() },
    budget: budget && {
      hourBucket: budget.bucket,
      peak: budget.peak,
      spentFen: Math.round(budget.spentFen * 100) / 100,
      budgetFen: HOUR_BUDGET_FEN,
      calls: budget.calls,
      breaker: budget.broken,
    },
    time: new Date().toISOString(),
  });
}
