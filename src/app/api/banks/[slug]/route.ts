import { NextResponse } from "next/server";
import { deleteBank, getBank, getQuestions, isOwner, updateBank } from "@/lib/db";
import type { Visibility } from "@/lib/types";
import {
  captureLegacyBankForShadow,
  deleteLegacyBankShadow,
  syncLegacyBankShadow,
} from "@/features/legacy/legacy-shadow-server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const bank = getBank(slug);
  if (!bank) return NextResponse.json({ error: "题库不存在" }, { status: 404 });
  const ownerKey = req.headers.get("x-owner-key");
  const owner = isOwner(bank, ownerKey);
  if (bank.visibility === "private" && !owner) {
    return NextResponse.json({ error: "这是私有题库,仅创建者可见" }, { status: 403 });
  }
  // 刷题页一次性下发全部题目,切题零请求
  const questions = getQuestions(bank.id);
  return NextResponse.json({
    bank: { slug: bank.slug, title: bank.title, visibility: bank.visibility, created_at: bank.created_at },
    questions,
    isOwner: owner,
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const bank = getBank(slug);
  if (!bank) return NextResponse.json({ error: "题库不存在" }, { status: 404 });
  if (!isOwner(bank, req.headers.get("x-owner-key"))) {
    return NextResponse.json({ error: "无管理权限" }, { status: 403 });
  }
  let body: { title?: string; visibility?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  const fields: { title?: string; visibility?: Visibility } = {};
  if (typeof body.title === "string" && body.title.trim()) fields.title = body.title.trim().slice(0, 80);
  if (["private", "unlisted", "public"].includes(body.visibility ?? "")) fields.visibility = body.visibility as Visibility;
  updateBank(bank.id, fields);
  const shadowSync = await syncLegacyBankShadow(slug);
  return NextResponse.json({ ok: true, ...(shadowSync ? { shadow_sync: shadowSync } : {}) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { slug } = await ctx.params;
  const bank = getBank(slug);
  if (!bank) return NextResponse.json({ error: "题库不存在" }, { status: 404 });
  if (!isOwner(bank, req.headers.get("x-owner-key"))) {
    return NextResponse.json({ error: "无管理权限" }, { status: 403 });
  }
  const shadowBank = captureLegacyBankForShadow(slug);
  deleteBank(bank.id);
  const shadowSync = await deleteLegacyBankShadow(shadowBank);
  return NextResponse.json({ ok: true, ...(shadowSync ? { shadow_sync: shadowSync } : {}) });
}
