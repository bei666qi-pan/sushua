"use client";

import { useMemo, useRef, useState } from "react";
import type { QType } from "@/lib/types";

interface Props {
  stem: string;
  options: string[];
  answer: string;
  type: QType;
}

type Status = "idle" | "streaming" | "done" | "error";

/** 把 AI 输出按【为什么】【干扰项】两段标记切块;旧缓存无标记则回退整段 */
function parseSections(text: string): { why: string; traps: string[]; plain: string } {
  const clean = text.replace(/\*\*/g, "").trim();
  const grab = (marker: string) => {
    const m = clean.match(new RegExp(`【${marker}】\\s*([\\s\\S]*?)(?=【|$)`));
    return m ? m[1].trim() : "";
  };
  const why = grab("为什么");
  const trapsRaw = grab("干扰项");
  if (!why && !trapsRaw) return { why: "", traps: [], plain: clean };
  const traps = trapsRaw
    ? trapsRaw.split(/[;;]\s*/).map((s) => s.trim()).filter(Boolean)
    : [];
  return { why, traps, plain: "" };
}

/** SSE 流式 AI 解析:同一题全站缓存,二次请求秒回 */
export function AiExplain({ stem, options, answer, type }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [text, setText] = useState("");
  const [cached, setCached] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const runningRef = useRef(false);

  const sections = useMemo(() => parseSections(text), [text]);

  const run = async () => {
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
        body: JSON.stringify({ stem, options, answer, type }),
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
              if (json.t === "meta") setCached(!!json.cached);
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
        onClick={run}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-pine/40 bg-pine-soft px-3 py-1.5 text-sm text-pine transition-colors hover:bg-pine hover:text-white"
      >
        ✦ AI 解析
      </button>
    );
  }

  const streaming = status === "streaming";

  return (
    <div className="fade-up mt-3 overflow-hidden rounded-xl border border-pine/20 bg-card">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-line bg-pine-soft/50 px-3.5 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-pine">
          ✦ AI 解析
          {cached && <span className="rounded-full bg-pine/10 px-1.5 py-0.5 text-[10px]">缓存秒回</span>}
          {streaming && !text && <span className="text-ink-faint">思考中…</span>}
        </span>
        {(status === "done" || status === "error") && (
          <button onClick={run} className="text-xs text-ink-faint transition-colors hover:text-pine">
            重新生成
          </button>
        )}
      </div>

      {status === "error" ? (
        <p className="px-3.5 py-3 text-sm text-bad">{errMsg}</p>
      ) : (
        <div className="space-y-2.5 px-3.5 py-3">
          {/* 骨架:等待首字 */}
          {streaming && !text && (
            <div className="space-y-2">
              <div className="h-3.5 w-4/5 animate-pulse rounded bg-line" />
              <div className="h-3.5 w-3/5 animate-pulse rounded bg-line" />
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
            <div className="flex gap-2">
              <span className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-ok-soft text-[10px] text-ok">
                ✓
              </span>
              <p className={`text-sm leading-relaxed ${streaming && !sections.traps.length ? "stream-cursor" : ""}`}>
                {sections.why}
              </p>
            </div>
          )}

          {/* 干扰项 */}
          {sections.traps.length > 0 && (
            <div className="space-y-1 border-t border-dashed border-line pt-2.5">
              {sections.traps.map((t, i) => {
                const m = t.match(/^([A-F])\s*[::]\s*(.*)$/);
                return (
                  <div key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-soft">
                    {m ? (
                      <>
                        <span className="mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-bad-soft text-[10px] font-medium text-bad">
                          {m[1]}
                        </span>
                        <span className={streaming && i === sections.traps.length - 1 ? "stream-cursor" : ""}>{m[2]}</span>
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
          )}
        </div>
      )}
    </div>
  );
}
