"use client";

import { useRef, useState } from "react";
import type { QType } from "@/lib/types";

interface Props {
  stem: string;
  options: string[];
  answer: string;
  type: QType;
}

type Status = "idle" | "streaming" | "done" | "error";

/** SSE 流式 AI 解析:同一题全站缓存,二次请求秒回 */
export function AiExplain({ stem, options, answer, type }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [text, setText] = useState("");
  const [cached, setCached] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const runningRef = useRef(false);

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

  return (
    <div className="mt-3 rounded-lg border border-pine/25 bg-pine-soft/60 p-3">
      <div className="flex items-center justify-between text-xs text-pine">
        <span className="font-medium">✦ AI 解析{cached ? " · 缓存秒回" : ""}</span>
        {(status === "done" || status === "error") && (
          <button onClick={run} className="text-ink-faint hover:text-pine">
            重新生成
          </button>
        )}
      </div>
      {status === "error" ? (
        <p className="mt-2 text-sm text-bad">{errMsg}</p>
      ) : (
        <p className={`mt-2 whitespace-pre-wrap text-sm leading-relaxed ${status === "streaming" ? "stream-cursor" : ""}`}>
          {text || (status === "streaming" ? "思考中" : "")}
        </p>
      )}
    </div>
  );
}
