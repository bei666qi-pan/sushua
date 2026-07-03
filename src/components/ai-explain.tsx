"use client";

import { useMemo, useRef, useState } from "react";
import type { QType } from "@/lib/types";

interface Props {
  stem: string;
  options: string[];
  answer: string;
  type: QType;
  /** 用户答错时的选择(如"B"),用于在干扰项里标注"你选的";纯前端个性化,不影响全站缓存 */
  userChoice?: string;
}

type Status = "idle" | "streaming" | "done" | "error";

interface Sections {
  doubt: string;
  why: string;
  traps: string[];
  memo: string;
  plain: string;
}

/** 把 AI 输出按【存疑】【为什么】【干扰项】【速记】标记切块;旧缓存无标记则回退整段 */
function parseSections(text: string): Sections {
  const clean = text.replace(/\*\*/g, "").trim();
  const grab = (marker: string) => {
    const m = clean.match(new RegExp(`【${marker}】\\s*([\\s\\S]*?)(?=【|$)`));
    return m ? m[1].trim() : "";
  };
  const doubt = grab("存疑");
  const why = grab("为什么");
  const trapsRaw = grab("干扰项");
  const memo = grab("速记");
  if (!why && !trapsRaw) return { doubt: "", why: "", traps: [], memo: "", plain: clean };
  const traps = trapsRaw
    ? trapsRaw.split(/[;;]\s*/).map((s) => s.trim()).filter(Boolean)
    : [];
  return { doubt, why, traps, memo, plain: "" };
}

/** 当前 prompt 版本,与服务端 EXPLAIN_PROMPT_VERSION 对应;低于它的缓存展示"旧版"标识 */
const CURRENT_VERSION = 2;

/** 四角星:AI 标识 */
function Spark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2c.55 3.87 1.66 6.4 3.3 8.05 1.65 1.64 4.18 2.75 8.05 3.3-3.87.55-6.4 1.66-8.05 3.3-1.64 1.65-2.75 4.18-3.3 8.05-.55-3.87-1.66-6.4-3.3-8.05C7.05 15.01 4.52 13.9.65 13.35c3.87-.55 6.4-1.66 8.05-3.3C10.34 8.4 11.45 5.87 12 2Z" />
    </svg>
  );
}

/** 分区小标题 */
function SectionLabel({ tone, children }: { tone: "ok" | "bad" | "pine"; children: React.ReactNode }) {
  const bar = tone === "ok" ? "bg-ok" : tone === "bad" ? "bg-bad" : "bg-pine";
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className={`h-3 w-0.5 rounded-full ${bar}`} />
      <span className="text-[11px] font-medium tracking-wider text-ink-faint">{children}</span>
    </div>
  );
}

/** 思考中的三个小点 */
function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label="思考中">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="ai-dot inline-block h-1 w-1 rounded-full bg-pine"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

/** SSE 流式 AI 解析:同一题全站缓存,二次请求秒回 */
export function AiExplain({ stem, options, answer, type, userChoice }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [text, setText] = useState("");
  const [cached, setCached] = useState(false);
  const [version, setVersion] = useState(CURRENT_VERSION);
  const [errMsg, setErrMsg] = useState("");
  const runningRef = useRef(false);

  const sections = useMemo(() => parseSections(text), [text]);

  const run = async (force = false) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setStatus("streaming");
    setText("");
    setErrMsg("");
    setCached(false);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stem, options, answer, type, ...(force ? { force: true } : {}) }),
      });
      if (!res.ok || !res.body) throw new Error("网络错误");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ok = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          for (const line of ev.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const json = JSON.parse(line.slice(5).trim());
              if (json.t === "meta") {
                setCached(!!json.cached);
                setVersion(typeof json.v === "number" ? json.v : CURRENT_VERSION);
              }
              else if (json.t === "delta") setText((t) => t + json.c);
              else if (json.t === "done") ok = true;
              else if (json.t === "error") {
                setErrMsg(json.msg || "解析失败");
                setStatus("error");
                return;
              }
            } catch {}
          }
        }
      }
      setStatus(ok ? "done" : "error");
      if (!ok) setErrMsg("连接中断,请重试");
    } catch {
      setStatus("error");
      setErrMsg("网络异常,请重试");
    } finally {
      runningRef.current = false;
    }
  };

  if (status === "idle") {
    return (
      <button
        onClick={() => run()}
        className="group mt-3 inline-flex items-center gap-1.5 rounded-full border border-pine/30 bg-gradient-to-b from-card to-pine-soft/70 px-3.5 py-1.5 text-sm font-medium text-pine shadow-[0_1px_2px_rgb(20_82_63/0.06)] transition-all duration-200 hover:-translate-y-px hover:border-pine/50 hover:shadow-[0_3px_10px_rgb(20_82_63/0.14)] active:translate-y-0 active:shadow-none"
      >
        <Spark className="h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-90 group-hover:scale-110" />
        AI 解析
      </button>
    );
  }

  const streaming = status === "streaming";

  return (
    <div className="fade-up mt-3 overflow-hidden rounded-xl border border-pine/20 bg-card shadow-card">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-line bg-gradient-to-r from-pine-soft/70 to-pine-soft/20 px-3.5 py-2">
        <span className="flex items-center gap-2 text-xs font-medium text-pine">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-pine text-white shadow-[0_1px_3px_rgb(20_82_63/0.3)]">
            <Spark className={`h-3 w-3 ${streaming ? "ai-spark-live" : ""}`} />
          </span>
          AI 解析
          {cached && (
            <span className="rounded-full border border-pine/15 bg-card/80 px-1.5 py-0.5 text-[10px] font-normal text-pine/80">
              ⚡ 缓存秒回
            </span>
          )}
          {cached && version < CURRENT_VERSION && (
            <span className="rounded-full bg-warn-soft px-1.5 py-0.5 text-[10px] font-normal text-warn">
              旧版·可重新生成
            </span>
          )}
          {streaming && !text && (
            <span className="flex items-center gap-1.5 font-normal text-ink-faint">
              思考中 <ThinkingDots />
            </span>
          )}
          {streaming && text && <ThinkingDots />}
        </span>
        {(status === "done" || status === "error") && (
          <button
            onClick={() => run(true)}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:bg-pine-soft hover:text-pine"
          >
            ↻ 重新生成
          </button>
        )}
      </div>

      {status === "error" ? (
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <p className="text-sm text-bad">{errMsg}</p>
          <button
            onClick={() => run(true)}
            className="shrink-0 rounded-full border border-bad/30 px-3 py-1 text-xs text-bad transition-colors hover:bg-bad-soft"
          >
            重试
          </button>
        </div>
      ) : (
        <div className="space-y-3 px-3.5 py-3">
          {/* 骨架:等待首字 */}
          {streaming && !text && (
            <div className="space-y-2">
              <div className="ai-shimmer h-3.5 w-11/12 rounded" />
              <div className="ai-shimmer h-3.5 w-4/5 rounded" style={{ animationDelay: "0.15s" }} />
              <div className="ai-shimmer h-3.5 w-3/5 rounded" style={{ animationDelay: "0.3s" }} />
            </div>
          )}

          {/* 答案存疑:AI 独立解题与题库答案不一致时的提示 */}
          {sections.doubt && (
            <div className="ai-section flex gap-2 rounded-lg border-l-2 border-warn bg-warn-soft px-3 py-2.5">
              <span className="mt-px shrink-0 text-[13px]">⚠</span>
              <p className="text-[13px] leading-relaxed text-ink-soft">
                <span className="font-medium text-warn">答案存疑</span>:{sections.doubt}
              </p>
            </div>
          )}

          {/* 旧缓存/无标记内容:整段展示 */}
          {sections.plain && (
            <p className={`whitespace-pre-wrap text-sm leading-relaxed ${streaming ? "stream-cursor" : ""}`}>
              {sections.plain}
            </p>
          )}

          {/* 为什么选它 */}
          {sections.why && (
            <div className="ai-section">
              <SectionLabel tone="ok">为什么选它</SectionLabel>
              <div className="flex gap-2">
                <span className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-ok-soft text-[10px] text-ok">
                  ✓
                </span>
                <p className={`text-sm leading-relaxed ${streaming && !sections.traps.length ? "stream-cursor" : ""}`}>
                  {sections.why}
                </p>
              </div>
            </div>
          )}

          {/* 干扰项:用户答错时标注"你选的",把讲解和这次错误关联起来 */}
          {sections.traps.length > 0 && (
            <div className="ai-section">
              <SectionLabel tone="bad">干扰项拆解</SectionLabel>
              <div className="space-y-1.5">
                {sections.traps.map((t, i) => {
                  const m = t.match(/^([A-F])\s*[::]\s*(.*)$/);
                  const mine = !!m && !!userChoice && userChoice.toUpperCase().includes(m[1]);
                  return (
                    <div
                      key={i}
                      className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-relaxed text-ink-soft ${
                        mine ? "bg-bad-soft/60" : ""
                      }`}
                    >
                      {m ? (
                        <>
                          <span
                            className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium ${
                              mine ? "bg-bad text-white" : "bg-bad-soft text-bad"
                            }`}
                          >
                            {m[1]}
                          </span>
                          <span className={streaming && i === sections.traps.length - 1 ? "stream-cursor" : ""}>
                            {mine && (
                              <span className="mr-1.5 rounded bg-bad-soft px-1 py-0.5 text-[10px] font-medium text-bad">
                                你选的
                              </span>
                            )}
                            {m[2]}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="mt-0.5 shrink-0 text-bad">·</span>
                          <span className={streaming && i === sections.traps.length - 1 ? "stream-cursor" : ""}>{t}</span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 速记口诀:纸条便签风 */}
          {sections.memo && (
            <div className="ai-section relative mt-1 rounded-lg border border-dashed border-pine/40 bg-pine-soft/60 px-3.5 py-2.5">
              <span className="absolute -top-2 left-3 rounded bg-card px-1.5 text-[10px] font-medium tracking-wider text-pine">
                📌 速记
              </span>
              <p className={`font-display text-[13.5px] font-medium leading-relaxed text-pine-deep ${streaming ? "stream-cursor" : ""}`}>
                {sections.memo}
              </p>
            </div>
          )}

          {/* 完成后的免责小注 */}
          {status === "done" && (
            <p className="pt-0.5 text-right text-[10px] text-ink-faint/80">内容由 AI 生成,仅供参考</p>
          )}
        </div>
      )}
    </div>
  );
}
