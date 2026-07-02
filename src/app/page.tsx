import Link from "next/link";
import { listPublicBanks } from "@/lib/db";
import { MyBanks } from "@/components/my-banks";

export const dynamic = "force-dynamic";

const STEPS = [
  { n: "①", title: "上传题库文件", desc: "PDF / Word / TXT 都行,拖进来就好" },
  { n: "②", title: "确认题目", desc: "自动切题,答案不对可以随手改" },
  { n: "③", title: "开刷", desc: "速刷判分 · 速记背题 · AI 讲解" },
];

export default function HomePage() {
  const banks = listPublicBanks();
  return (
    <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
      {/* Hero:左对齐,衬线大标题 */}
      <section className="pb-10 pt-12 sm:pb-14 sm:pt-20">
        <h1 className="font-display max-w-2xl text-4xl font-bold leading-tight sm:text-5xl">
          期末题库,
          <br className="sm:hidden" />
          上传即变刷题神器
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-soft sm:text-lg">
          把老师发的题库文件丢进来,自动切成一道道题。
          做题判分、直接背答案、错题重刷,还有 AI 给你讲为什么。
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            href="/upload"
            className="rounded-lg bg-pine px-6 py-3 text-base font-medium text-white shadow-card transition-colors hover:bg-pine-deep"
          >
            上传题库,马上开刷
          </Link>
          <Link
            href="/b/demo"
            className="rounded-lg border border-line-strong bg-card px-6 py-3 text-base text-ink transition-colors hover:border-pine hover:text-pine"
          >
            先拿示例题库试试
          </Link>
        </div>
        {/* 三步引导 */}
        <div className="mt-12 grid gap-3 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-xl border border-line bg-card p-4">
              <div className="flex items-baseline gap-2">
                <span className="font-display text-lg text-pine">{s.n}</span>
                <span className="font-medium">{s.title}</span>
              </div>
              <p className="mt-1 text-sm text-ink-soft">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <MyBanks />

      {/* 题库广场 */}
      <section className="pb-16 pt-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-bold">题库广场</h2>
          <span className="text-xs text-ink-faint">公开题库,人人可刷</span>
        </div>
        {banks.length === 0 ? (
          <p className="mt-6 text-sm text-ink-soft">还没有公开题库,上传一份并设为公开,它就会出现在这里。</p>
        ) : (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {banks.map((b) => (
              <Link
                key={b.slug}
                href={`/b/${b.slug}`}
                className="group rounded-xl border border-line bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-pine hover:shadow-pop"
              >
                <div className="line-clamp-2 font-medium leading-snug group-hover:text-pine">{b.title}</div>
                <div className="mt-3 flex items-center justify-between text-xs text-ink-faint">
                  <span>{b.question_count} 题</span>
                  <span>{(b.created_at ?? "").slice(0, 10)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
