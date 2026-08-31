"use client";

import Link from "next/link";
import React, { useRef, useState } from "react";
import {
  LegacyBankClaimError,
  createLegacyBankClient,
  legacyClaimReturnPath,
} from "@/features/legacy/client";

const client = createLegacyBankClient();

export function LegacyBankClaimPanel({
  slug,
  pendingAfterLogin,
}: {
  slug: string;
  pendingAfterLogin: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [succeeded, setSucceeded] = useState(false);
  const idempotencyKey = useRef("");

  async function claim() {
    const ownerKey = localStorage.getItem(`sushua:owner:${slug}`) ?? "";
    if (!ownerKey) {
      setError("本机没有这份题库的管理凭证，无法认领。");
      return;
    }

    setPending(true);
    setError("");
    idempotencyKey.current ||= crypto.randomUUID();
    try {
      await client.claim(slug, ownerKey, idempotencyKey.current);
      idempotencyKey.current = "";
      setSucceeded(true);
      window.history.replaceState(null, "", `/b/${encodeURIComponent(slug)}`);
    } catch (caught) {
      if (caught instanceof LegacyBankClaimError && caught.code === "authentication_required") {
        window.location.assign(`/login?next=${encodeURIComponent(legacyClaimReturnPath(slug))}`);
        return;
      }
      setError(messageFor(caught));
    } finally {
      setPending(false);
    }
  }

  if (succeeded) {
    return (
      <div role="status" className="mb-4 rounded-xl border border-pine/25 bg-pine-soft px-4 py-3 text-sm text-pine-deep">
        <p className="font-medium">已认领到当前账号</p>
        <p className="mt-1 leading-relaxed text-ink-soft">资料库所有权已同步；当前题目仍由旧题库读取，不会被覆盖。</p>
        <Link href="/workspaces" className="mt-2 inline-flex min-h-10 items-center font-medium text-pine hover:underline">查看我的资料库 →</Link>
      </div>
    );
  }

  return (
    <section className="mb-4 rounded-xl border border-pine/25 bg-pine-soft px-4 py-3" aria-labelledby="legacy-claim-title">
      <h2 id="legacy-claim-title" className="text-sm font-medium text-pine-deep">
        {pendingAfterLogin ? "登录完成，继续认领旧题库" : "把这份旧题库带到个人资料库"}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
        只在点击后验证本机管理凭证，不会把凭证放进网址。认领只同步资料库所有权，当前题目仍由旧题库读取。
      </p>
      {error ? <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
      <button
        type="button"
        onClick={() => void claim()}
        disabled={pending}
        className="mt-3 min-h-11 rounded-xl bg-pine px-4 py-2 text-sm font-medium text-white transition hover:bg-pine-deep disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "正在认领…" : pendingAfterLogin ? "完成认领" : "认领到账号"}
      </button>
    </section>
  );
}

function messageFor(caught: unknown) {
  if (!(caught instanceof LegacyBankClaimError)) return "认领失败，请稍后重试。";
  if (caught.code === "workspace_not_found") return "这份题库尚未进入资料库迁移，请稍后再试。";
  if (caught.code === "invalid_legacy_owner_key") return "本机的旧管理凭证无效，题库不会被更改。";
  return caught.message;
}
