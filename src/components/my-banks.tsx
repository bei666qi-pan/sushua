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

export function MyBanks() {
  const [banks, setBanks] = useState<MyBank[]>([]);
  const [ready, setReady] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    setBanks(loadMyBanks());
    setReady(true);
  }, []);

  const remove = async (slug: string, title: string) => {
    if (!confirm(`删除题库「${title}」?这个操作不可恢复。`)) return;
    const ownerKey = localStorage.getItem(`sushua:owner:${slug}`) ?? "";
    setDeleting(slug);
    try {
      const res = await fetch(`/api/banks/${slug}`, { method: "DELETE", headers: { "x-owner-key": ownerKey } });
      if (res.ok || res.status === 404) {
        // 404 说明题库已不存在(比如已被别处删过),同样从本机记录里清掉
        forgetBank(slug);
        localStorage.removeItem(`sushua:owner:${slug}`);
        localStorage.removeItem(`sushua:prog:${slug}`);
        setBanks(loadMyBanks());
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "删除失败,可能不是这台设备创建的题库");
      }
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
                remove(b.slug, b.title);
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
    </section>
  );
}
