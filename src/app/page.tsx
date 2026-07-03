import Link from "next/link";
import { listPublicBanks } from "@/lib/db";
import { MyBanks } from "@/components/my-banks";
import { HeroDemo } from "@/components/hero-demo";

export const dynamic = "force-dynamic";

const STEPS = [
  { n: "①", title: "上传题库文件", desc: "PDF / Word / TXT 都行,拖进来就好" },
  { n: "②", title: "确认题目", desc: "自动切题,答案不对随手改" },
  { n: "③", title: "开刷", desc: "判分 · 背题 · 错题重刷 · AI 讲解" },
];

const FEATURES = [
  {
    title: "即点即判",
    desc: "选项点下去立刻知道对错,答错当场高亮正确答案,不用翻到最后一页对答案。",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.2 2.4 2.4 4.6-5" />
      </svg>
    ),
  },
  {
    title: "速记模式",
    desc: "题目答案同屏,卡片流上下滑着背;「只看答案」视图留给考前最后 30 分钟。",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M6 4h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
        <path d="M9 8h6M9 12h6M9 16h3" />
      </svg>
    ),
  },
  {
    title: "错题本",
    desc: "答错自动收录,可以单独重刷;刷对了自动移出,考前只剩真不会的。",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M5 4a1 1 0 0 1 1-1h9.6L19 6.4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4Z" />
        <path d="m9.6 10.6 4.8 4.8M14.4 10.6l-4.8 4.8" />
      </svg>
    ),
  },
  {
    title: "AI 讲解",
    desc: "为什么选它、干扰项错在哪、考点口诀,一键生成;答案存疑还会直说,不圆谎。",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9 12 3.5Z" />
        <path d="M19 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6Z" strokeWidth="1.4" />
      </svg>
    ),
  },
];

export default function HomePage() {
  const banks = listPublicBanks();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
      {/* Hero:左文右卡,右侧自动演示真实刷题界面 */}
      <section className="hero-halo -mx-4 px-4 pb-12 pt-10 sm:-mx-6 sm:px-6 sm:pt-16 lg:-mx-8 lg:px-8">
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_minmax(0,440px)] lg:gap-14">
          <div>
            <h1 className="fade-up font-display text-4xl font-bold leading-tight sm:text-5xl">
              期末题库,
              <br className="sm:hidden" />
              上传即变<span className="hl-mark">刷题神器</span>
            </h1>
            <p className="fade-up d1 mt-5 max-w-xl text-base leading-relaxed text-ink-soft sm:text-lg">
              老师甩来的 PDF / Word / TXT 丢进来,30 秒切成一道道题。
              即点即判、速记背题、错题重刷,AI 还给你讲为什么。
            </p>
            <div className="fade-up d2 mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/upload"
                className="group rounded-xl bg-pine px-6 py-3 text-base font-medium text-white shadow-card transition-all hover:-translate-y-0.5 hover:bg-pine-deep hover:shadow-pop"
              >
                上传题库,马上开刷
                <span className="ml-1.5 inline-block transition-transform group-hover:translate-x-0.5">→</span>
              </Link>
              <Link
                href="/b/demo"
                className="rounded-xl border border-line-strong bg-card px-6 py-3 text-base text-ink transition-colors hover:border-pine hover:text-pine"
              >
                先拿示例题库试试
              </Link>
            </div>
            <p className="fade-up d3 mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-faint">
              <span>无需注册</span>
              <span aria-hidden>·</span>
              <span>全站免费</span>
              <span aria-hidden>·</span>
              <span>手机也好用</span>
              <span aria-hidden>·</span>
              <span>进度存本机,断点续刷</span>
            </p>
          </div>
          <div className="fade-up d1 pt-2 lg:pt-0">
            <HeroDemo />
          </div>
        </div>

        {/* 三步流程:虚线牵引的时间轴 */}
        <div className="mt-14 grid gap-6 sm:grid-cols-3 sm:gap-0">
          {STEPS.map((s, i) => (
            <div key={s.n} className={`fade-up d${i + 1} relative flex gap-3.5 sm:block sm:pr-8`}>
              {i < STEPS.length - 1 && (
                <span aria-hidden className="step-dash absolute left-[3.1rem] top-[1.15rem] hidden h-0.5 w-[calc(100%-4.6rem)] sm:block" />
              )}
              <span className="font-display flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line-strong bg-card text-base font-bold text-pine shadow-card">
                {i + 1}
              </span>
              <div className="sm:mt-3">
                <div className="font-medium leading-9 sm:leading-normal">{s.title}</div>
                <p className="mt-0.5 text-sm text-ink-soft">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 功能亮点:上传只是开始 */}
      <section className="pb-4 pt-10 sm:pt-12">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-2xl font-bold">不只是把题切出来</h2>
          <span className="text-xs text-ink-faint">上传只是开始,刷起来才是正事</span>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group rounded-xl border border-line bg-card p-5 shadow-card transition-all hover:-translate-y-0.5 hover:border-pine/40 hover:shadow-pop"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-pine-soft text-pine transition-colors group-hover:bg-pine group-hover:text-white">
                {f.icon}
              </div>
              <div className="mt-3 font-medium">{f.title}</div>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="pt-10">
        <MyBanks />
      </div>

      {/* 题库广场 */}
      <section className="pb-14 pt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-bold">题库广场</h2>
          <span className="text-xs text-ink-faint">公开题库,人人可刷</span>
        </div>
        {banks.length === 0 ? (
          <Link
            href="/upload"
            className="mt-6 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong px-6 py-12 text-center transition-colors hover:border-pine"
          >
            <span className="text-sm text-ink-soft">还没有公开题库</span>
            <span className="text-sm font-medium text-pine">上传一份并设为公开,让它出现在这里 →</span>
          </Link>
        ) : (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {banks.map((b) => (
              <Link
                key={b.slug}
                href={`/b/${b.slug}`}
                className="group relative rounded-xl border border-line bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:border-pine hover:shadow-pop"
              >
                <span
                  aria-hidden
                  className="absolute right-3.5 top-3 text-ink-faint opacity-0 transition-all group-hover:translate-x-0.5 group-hover:text-pine group-hover:opacity-100"
                >
                  ↗
                </span>
                <div className="line-clamp-2 pr-5 font-medium leading-snug group-hover:text-pine">{b.title}</div>
                <div className="mt-3 flex items-center justify-between text-xs text-ink-faint">
                  <span className="inline-flex items-center rounded bg-paper px-1.5 py-0.5 font-medium text-ink-soft">
                    {b.question_count} 题
                  </span>
                  <span>{(b.created_at ?? "").slice(0, 10)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 收尾 CTA */}
      <section className="pb-16">
        <div className="band-grain relative overflow-hidden rounded-3xl bg-pine-deep px-6 py-12 text-center sm:px-10 sm:py-14">
          <h2 className="font-display text-2xl font-bold leading-snug text-white sm:text-3xl">
            期末周,别再对着 PDF 干瞪眼
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-white/70 sm:text-base">
            上传只要 30 秒,刷完这科算这科。题库还能一键分享给同学,一起刷。
          </p>
          <Link
            href="/upload"
            className="mt-7 inline-block rounded-xl bg-white px-7 py-3 text-base font-medium text-pine-deep shadow-pop transition-transform hover:-translate-y-0.5"
          >
            上传题库 →
          </Link>
        </div>
      </section>
    </div>
  );
}
