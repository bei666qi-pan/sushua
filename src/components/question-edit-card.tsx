"use client";

import { memo } from "react";
import type { DraftQuestion, QType } from "@/lib/types";
import { TYPE_LABEL } from "@/lib/types";

const TYPES: QType[] = ["single", "multiple", "judge", "fill", "short"];

interface Props {
  q: DraftQuestion;
  index: number;
  onPatch: (index: number, patch: Partial<DraftQuestion>) => void;
  onDelete: (index: number) => void;
}

/**
 * memo 化:大题库(几百题)确认页里,改一个字只应重渲染这一张卡片。
 * onPatch/onDelete 是父组件用 useCallback(空依赖)包过的稳定引用,
 * 配合默认浅比较,其它卡片的 props 引用不变就不会重渲染。
 */
function QuestionEditCardImpl({ q, index, onPatch, onDelete }: Props) {
  const patch = (p: Partial<DraftQuestion>) => onPatch(index, p);

  return (
    <div className="rounded-xl border border-line bg-card p-4 [content-visibility:auto] [contain-intrinsic-size:auto_260px]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-faint">第 {index + 1} 题</span>
          <select
            value={q.type}
            onChange={(e) => patch({ type: e.target.value as QType })}
            className="rounded border border-line bg-paper px-1.5 py-0.5 text-xs"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          {!q.answer && <span className="rounded bg-warn-soft px-1.5 py-0.5 text-xs text-bad">缺答案</span>}
        </div>
        <button onClick={() => onDelete(index)} className="text-xs text-ink-faint hover:text-bad">
          删除
        </button>
      </div>
      <input
        value={q.chapter ?? ""}
        onChange={(e) => patch({ chapter: e.target.value })}
        placeholder="所属章节(可选,如「第一章 绪论」)"
        className="mt-2 w-full rounded-lg border border-dashed border-line bg-paper px-2.5 py-1 text-xs text-ink-soft outline-none focus:border-pine focus:text-ink"
      />
      <textarea
        value={q.stem}
        onChange={(e) => patch({ stem: e.target.value })}
        rows={Math.min(4, Math.max(2, Math.ceil(q.stem.length / 40)))}
        className="mt-2 w-full resize-y rounded-lg border border-line bg-paper px-3 py-2 text-sm leading-relaxed outline-none focus:border-pine"
      />
      {(q.type === "single" || q.type === "multiple") && (
        <div className="mt-2 space-y-1.5">
          {q.options.map((opt, oi) => (
            <div key={oi} className="flex items-center gap-2">
              <span className="w-5 text-center text-xs font-medium text-ink-soft">
                {String.fromCharCode(65 + oi)}
              </span>
              <input
                value={opt}
                onChange={(e) => patch({ options: q.options.map((o, j) => (j === oi ? e.target.value : o)) })}
                className="flex-1 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm outline-none focus:border-pine"
              />
              <button
                onClick={() => patch({ options: q.options.filter((_, j) => j !== oi) })}
                className="text-xs text-ink-faint hover:text-bad"
              >
                ✕
              </button>
            </div>
          ))}
          {q.options.length < 8 && (
            <button
              onClick={() => patch({ options: [...q.options, ""] })}
              className="ml-7 text-xs text-pine hover:underline"
            >
              + 加选项
            </button>
          )}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="shrink-0 text-xs text-ink-soft">答案</span>
        <input
          value={q.answer}
          onChange={(e) => patch({ answer: e.target.value })}
          placeholder={
            q.type === "single" ? "如 A" : q.type === "multiple" ? "如 ABD" : q.type === "judge" ? "对 / 错" : "文本答案"
          }
          className="w-full rounded-lg border border-line bg-paper px-3 py-1.5 text-sm outline-none focus:border-pine"
        />
      </div>
    </div>
  );
}

export const QuestionEditCard = memo(QuestionEditCardImpl);
