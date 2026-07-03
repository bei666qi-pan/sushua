"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * 首页 Hero 自动演示卡:循环播放「点选项 → 即时判分 → 下一题」,
 * 视觉完全复刻真实刷题界面,让人 3 秒看懂产品。点卡片可进示例题库真刷。
 */

type DemoQ = {
  tag: string;
  stem: string;
  options: string[]; // 空数组 = 判断题
  pick: number; // 演示时点第几个(0 起)
  answer: number; // 正确答案下标
  feedback: string;
  ok: boolean;
};

const SCRIPT: DemoQ[] = [
  {
    tag: "单选",
    stem: "HTTP 状态码 404 表示什么?",
    options: ["服务器内部错误", "请求成功", "资源未找到", "重定向"],
    pick: 2,
    answer: 2,
    feedback: "答对了,连对 ×3",
    ok: true,
  },
  {
    tag: "单选",
    stem: "下列哪种数据结构遵循「先进先出」原则?",
    options: ["栈", "队列", "二叉树", "哈希表"],
    pick: 0,
    answer: 1,
    feedback: "已收进错题本,正确答案 B",
    ok: false,
  },
  {
    tag: "判断",
    stem: "TCP 协议是面向连接的可靠传输协议。",
    options: [],
    pick: 0,
    answer: 0,
    feedback: "答对了,这套已刷完 60%",
    ok: true,
  },
];

const LETTERS = ["A", "B", "C", "D"];
const THINK_MS = 1000;
const REVEAL_MS = 2100;

export function HeroDemo() {
  const [qi, setQi] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [still, setStill] = useState(false); // prefers-reduced-motion:静态展示

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStill(true);
      setQi(1);
      setRevealed(true);
    }
  }, []);

  useEffect(() => {
    if (still) return;
    const t1 = setTimeout(() => setRevealed(true), THINK_MS);
    const t2 = setTimeout(() => {
      setRevealed(false);
      setQi((i) => (i + 1) % SCRIPT.length);
    }, THINK_MS + REVEAL_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [qi, still]);

  const q = SCRIPT[qi];
  const progress = 40 + qi * 10;

  const optionCls = (i: number) => {
    if (!revealed) return "border-line bg-paper";
    if (i === q.answer) return "border-ok bg-ok-soft";
    if (i === q.pick) return "border-bad bg-bad-soft";
    return "border-line bg-paper opacity-60";
  };

  const badgeCls = (i: number) => {
    if (!revealed) return "border-line-strong text-ink-soft";
    if (i === q.answer) return "border-ok bg-ok text-white";
    if (i === q.pick) return "border-bad bg-bad text-white";
    return "border-line-strong text-ink-soft";
  };

  return (
    <div className="mx-auto w-full max-w-[420px] select-none">
      <div className="relative">
        {/* 垫底的第二张"卷子" */}
        <div
          aria-hidden
          className="absolute inset-0 -rotate-2 rounded-2xl border border-line bg-card/70 shadow-card"
        />
        <Link
        href="/b/demo"
        aria-label="进入示例题库试刷"
        className="desk-float group relative block rounded-2xl border border-line bg-card p-5 shadow-pop transition-shadow hover:shadow-[0_4px_10px_rgb(35_32_26/0.1),0_20px_44px_rgb(35_32_26/0.16)]"
      >
        {/* 卡头:题库名 + 进度 */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-5 items-center rounded bg-pine-soft px-1.5 text-[11px] font-medium text-pine">
              {q.tag}
            </span>
            <span className="truncate text-xs text-ink-faint">计算机基础 · 期末题库</span>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-ink-faint">{4 + qi} / 10</span>
        </div>
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-pine transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* 题干 + 选项(key 切换触发入场动画) */}
        <div key={qi} className={still ? undefined : "fade-up"}>
          <p className="mt-4 min-h-[2.6rem] text-[15px] font-medium leading-relaxed">{q.stem}</p>

          <div className="mt-3 min-h-[186px]">
            {q.options.length > 0 ? (
              <div className="space-y-2">
                {q.options.map((opt, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2 text-sm transition-colors duration-300 ${optionCls(i)} ${
                      revealed && i === q.pick ? "demo-press" : ""
                    }`}
                  >
                    <span
                      className={`flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors duration-300 ${badgeCls(i)}`}
                    >
                      {LETTERS[i]}
                    </span>
                    <span className="truncate">{opt}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 pt-1">
                {["对", "错"].map((opt, i) => (
                  <div
                    key={opt}
                    className={`rounded-xl border py-4 text-center text-lg font-medium transition-colors duration-300 ${optionCls(i)} ${
                      revealed && i === q.pick ? "demo-press" : ""
                    }`}
                  >
                    {opt}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 判分反馈:固定高度,避免卡片跳动 */}
        <div className="mt-1 h-9">
          {revealed && (
            <div
              className={`pop-in flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium ${
                q.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"
              }`}
            >
              <span>{q.ok ? "✓" : "✕"}</span>
              <span>{q.feedback}</span>
            </div>
          )}
        </div>

        {/* 角标:提示这是活的演示 */}
        <span className="absolute -right-2 -top-2 inline-flex items-center gap-1 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] text-ink-soft shadow-card">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-pine opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-pine" />
          </span>
          自动演示
        </span>
        </Link>
      </div>

      <p className="mt-5 text-center text-xs text-ink-faint">
        点击卡片,进示例题库真刷一把 · 键盘 <kbd className="rounded border border-line-strong bg-card px-1">1-4</kbd> 选答案
      </p>
    </div>
  );
}
