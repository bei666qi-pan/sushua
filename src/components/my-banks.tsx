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
  useEffect(() => {
    setBanks(loadMyBanks());
    setReady(true);
  }, []);
  if (!ready || banks.length === 0) return null;
  return (
    <section className="pb-4">
      <h2 className="font-display text-2xl font-bold">我的题库</h2>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {banks.map((b) => (
          <Link
            key={b.slug}
            href={`/b/${b.slug}`}
            className="group rounded-xl border border-line bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-pine hover:shadow-pop"
          >
            <div className="line-clamp-2 font-medium leading-snug group-hover:text-pine">{b.title}</div>
            <div className="mt-3 text-xs text-ink-faint">{b.count} 题 · 本机记录</div>
          </Link>
        ))}
      </div>
    </section>
  );
}
