import { NextResponse } from "next/server";
import { createBank, listPublicBanks } from "@/lib/db";
import type { DraftQuestion, Visibility } from "@/lib/types";

export const dynamic = "force-dynamic";

const VISIBILITIES: Visibility[] = ["private", "unlisted", "public"];

export async function GET() {
  return NextResponse.json({ banks: listPublicBanks() });
}

export async function POST(req: Request) {
  let body: { title?: string; visibility?: string; questions?: DraftQuestion[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const title = (body.title ?? "").trim().slice(0, 80);
  const visibility = (VISIBILITIES.includes(body.visibility as Visibility) ? body.visibility : "private") as Visibility;
  const questions = Array.isArray(body.questions) ? body.questions : [];
  if (!title) return NextResponse.json({ error: "题库名称不能为空" }, { status: 400 });
  if (questions.length === 0) return NextResponse.json({ error: "题目不能为空" }, { status: 400 });
  if (questions.length > 2000) return NextResponse.json({ error: "单个题库最多 2000 题" }, { status: 400 });

  const clean: DraftQuestion[] = questions
    .filter((q) => q && typeof q.stem === "string" && q.stem.trim())
    .map((q) => ({
      type: ["single", "multiple", "judge", "fill", "short"].includes(q.type) ? q.type : "short",
      stem: q.stem.trim().slice(0, 4000),
      options: (Array.isArray(q.options) ? q.options : []).map((o) => String(o).slice(0, 500)).slice(0, 8),
      answer: String(q.answer ?? "").slice(0, 2000),
      explanation: q.explanation ? String(q.explanation).slice(0, 4000) : undefined,
      chapter: q.chapter ? String(q.chapter).trim().slice(0, 120) : undefined,
    }));
  if (clean.length === 0) return NextResponse.json({ error: "没有有效题目" }, { status: 400 });

  const { slug, ownerKey } = createBank(title, visibility, clean);
  return NextResponse.json({ slug, ownerKey });
}
