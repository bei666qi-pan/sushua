"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface MyBank {
  slug: string;
  title: string;
  count: number;
}

export function loadMyBanks(): MyBank[] {
  try {
    return JSON.parse(localStorage.getItem("sushua:mybanks") ?? "[]");
  } catch {
    return [];
  }
}

export function rememberBank(b: MyBank) {
  const list = loadMyBanks().filter((x) => x.slug !== b.slug);
  list.unshift(b);
  localStorage.setItem("sushua:mybanks", JSON.stringify(list.slice(0, 50)));
}

export function forgetBank(slug: string) {
  localStorage.setItem("sushua:mybanks", JSON.stringify(loadMyBanks().filter((x) => x.slug !== slug)));
}

type PendingRemove = { slug: string; title: string; isMine: boolean } | null;

export function MyBanks() {
  const [banks, setBanks] = useState<MyBank[]>([]);
  const [ready, setReady] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRemove>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBanks(loadMyBanks());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3200);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPending(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  const askRemove = (slug: string, title: string) => {
    const isMine = !!localStorage.getItem(`sushua:owner:${slug}`);
    setPending({ slug, title, isMine });
  };

  const confirmRemove = async () => {
    if (!pending) return;
    const { slug, isMine } = pending;
    setPending(null);
    setDeleting(slug);
    try {
      // 非本机创建的题库无管理权限,只清本地书签,不请求云端删除
      if (isMine) {
        const ownerKey = localStorage.getItem(`sushua:owner:${slug}`) ?? "";
        const res = await fetch(`/api/banks/${slug}`, { method: "DELETE", headers: { "x-owner-key": ownerKey } });
        if (!res.ok && res.status !== 404 && res.status !== 403) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || "删除失败,请稍后重试");
          return;
        }
      }
      forgetBank(slug);
      localStorage.removeItem(`sushua:owner:${slug}`);
      localStorage.removeItem(`sushua:prog:${slug}`);
      setBanks(loadMyBanks());
    } catch {
      setError("网络异常,删除失败,请稍后重试");
    } finally {
      setDeleting(null);
    }
  };

  if (!ready || banks.length === 0) return null;
  return (
    <section className="pb-4">
      <h2 className="font-display text-2xl font-bold">我的题库</h2>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {banks.map((b) => (
          <div
            key={b.slug}
            className="group relative rounded-xl border border-line bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-pine hover:shadow-pop"
          >
            <button
              onClick={(e) => {
                e.preventDefault();
                askRemove(b.slug, b.title);
              }}
              disabled={deleting === b.slug}
              aria-label="删除题库"
              title="删除题库"
              className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-full text-ink-faint opacity-0 transition-opacity hover:bg-bad-soft hover:text-bad group-hover:opacity-100 disabled:opacity-100"
            >
              {deleting === b.slug ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-bad" />
              ) : (
                "✕"
              )}
            </button>
            <Link href={`/b/${b.slug}`} className="block pr-6">
              <div className="line-clamp-2 font-medium leading-snug group-hover:text-pine">{b.title}</div>
              <div className="mt-3 text-xs text-ink-faint">{b.count} 题 · 本机记录</div>
            </Link>
          </div>
        ))}
      </div>

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 backdrop-blur-[2px]"
          onClick={() => setPending(null)}
        >
          <div
            className="fade-up w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-pop"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-bank-title"
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-full text-lg ${
                pending.isMine ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"
              }`}
            >
              {pending.isMine ? "⚠" : "↩"}
            </div>
            <h3 id="remove-bank-title" className="mt-3 font-display text-lg font-bold">
              {pending.isMine ? "删除题库" : "移除本机记录"}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {pending.isMine ? (
                <>
                  确定删除「<span className="font-medium text-ink">{pending.title}</span>」?题目数据将从云端一并删除,不可恢复。
                </>
              ) : (
                <>
                  「<span className="font-medium text-ink">{pending.title}</span>」不是本机创建的题库,移除仅清除本机记录,不影响云端数据及其他人查看。
                </>
              )}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPending(null)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-paper"
              >
                取消
              </button>
              <button
                onClick={confirmRemove}
                autoFocus
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                  pending.isMine ? "bg-bad hover:bg-bad/90" : "bg-pine hover:bg-pine-deep"
                }`}
              >
                {pending.isMine ? "删除" : "移除"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div className="fade-up flex items-center gap-2 rounded-full border border-bad/20 bg-bad-soft px-4 py-2.5 text-sm text-bad shadow-pop">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-bad/60 hover:text-bad" aria-label="关闭">
              ✕
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
