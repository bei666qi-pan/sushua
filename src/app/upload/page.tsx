"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DraftQuestion, Visibility } from "@/lib/types";
import { rememberBank } from "@/components/my-banks";
import { QuestionEditCard } from "@/components/question-edit-card";

type Step = "pick" | "parsing" | "confirm" | "saving";

const VIS_OPTIONS: Array<{ v: Visibility; label: string; desc: string }> = [
  { v: "private", label: "私有", desc: "只有你(本机)能看到" },
  { v: "unlisted", label: "链接可见", desc: "拿到链接的同学都能刷" },
  { v: "public", label: "公开", desc: "出现在首页题库广场" },
];

export default function UploadPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("pick");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [questions, setQuestions] = useState<DraftQuestion[]>([]);
  const [title, setTitle] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [aiNote, setAiNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleParsed = (data: { filename?: string; questions: DraftQuestion[]; stats?: { aiUsed?: boolean; aiSkipReason?: string } }) => {
    if (!data.questions?.length) {
      setError("没能从文件里切出题目。可以检查文件里是否有「1.」这样的题号和「答案:X」标注,或换个文件试试。");
      setStep("pick");
      return;
    }
    setQuestions(data.questions);
    setTitle((t) => t || data.filename || "我的题库");
    if (data.stats?.aiUsed) setAiNote("部分段落由 AI 辅助识别,请重点核对");
    setStep("confirm");
  };

  const uploadFile = useCallback(async (file: File) => {
    setError("");
    if (file.size > 20 * 1024 * 1024) {
      setError("文件超过 20MB 限制");
      return;
    }
    setStep("parsing");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/parse", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "解析失败");
      handleParsed(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败,请重试");
      setStep("pick");
    }
  }, []);

  const tryDemo = useCallback(async () => {
    setError("");
    setStep("parsing");
    try {
      const txt = await (await fetch("/demo.txt")).text();
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: txt, filename: "示例题库(计算机基础)" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "解析失败");
      handleParsed(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败,请重试");
      setStep("pick");
    }
  }, []);

  const save = async () => {
    setStep("saving");
    setError("");
    try {
      const res = await fetch("/api/banks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, visibility, questions }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      localStorage.setItem(`sushua:owner:${data.slug}`, data.ownerKey);
      rememberBank({ slug: data.slug, title, count: questions.length });
      router.push(`/b/${data.slug}?created=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败,请重试");
      setStep("confirm");
    }
  };

  // 稳定引用(空依赖 + 函数式 setState):配合 QuestionEditCard 的 memo,
  // 改一道题只重渲染那一张卡片,题库几百道题时确认页编辑仍然流畅
  const patchQ = useCallback((i: number, patch: Partial<DraftQuestion>) => {
    setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  }, []);
  const deleteQ = useCallback((i: number) => {
    setQuestions((qs) => qs.filter((_, j) => j !== i));
  }, []);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      {/* 步骤条 */}
      <div className="mb-8 flex items-center gap-2 text-sm">
        {["上传文件", "确认题目", "开刷"].map((label, i) => {
          const active = (step === "pick" || step === "parsing") ? i === 0 : i <= 1;
          return (
            <div key={label} className="flex items-center gap-2">
              {i > 0 && <span className="h-px w-6 bg-line-strong" />}
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                  active ? "bg-pine text-white" : "border border-line-strong text-ink-faint"
                }`}
              >
                {i + 1}
              </span>
              <span className={active ? "font-medium" : "text-ink-faint"}>{label}</span>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mb-5 rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">{error}</div>
      )}

      {(step === "pick" || step === "parsing") && (
        <div className="fade-up">
          <h1 className="font-display text-3xl font-bold">上传题库</h1>
          <p className="mt-2 text-sm text-ink-soft">
            支持 .pdf / .docx / .txt,最大 20MB。识别题号、选项和「答案:X」标注,自动切题。
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) uploadFile(f);
            }}
            onClick={() => step === "pick" && fileRef.current?.click()}
            className={`mt-6 flex min-h-56 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
              dragOver ? "border-pine bg-pine-soft" : "border-line-strong bg-card hover:border-pine"
            }`}
          >
            {step === "parsing" ? (
              <>
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-strong border-t-pine" />
                <p className="mt-4 text-sm text-ink-soft">正在切题,大文件可能要十几秒…</p>
              </>
            ) : (
              <>
                <div className="font-display text-4xl text-pine">⇪</div>
                <p className="mt-3 text-base font-medium">把题库文件拖到这里,或点击选择</p>
                <p className="mt-1 text-xs text-ink-faint">PDF · Word · TXT</p>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.doc,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
                e.target.value = "";
              }}
            />
          </div>
          {step === "pick" && (
            <button
              onClick={tryDemo}
              className="mt-4 text-sm text-pine underline decoration-dotted underline-offset-4 hover:text-pine-deep"
            >
              手头没有题库?用内置示例文件走一遍 →
            </button>
          )}
        </div>
      )}

      {(step === "confirm" || step === "saving") && (
        <div className="fade-up">
          <h1 className="font-display text-3xl font-bold">确认题目</h1>
          <p className="mt-2 text-sm text-ink-soft">
            共切出 <span className="font-medium text-pine">{questions.length}</span> 道题。
            {aiNote && <span className="text-bad"> {aiNote}。</span>}
            答案或题干不对,直接在下面改。
          </p>

          <div className="mt-6 rounded-xl border border-line bg-card p-4 sm:p-5">
            <label className="block text-sm font-medium">题库名称</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={80}
              className="mt-2 w-full rounded-lg border border-line-strong bg-paper px-3 py-2 text-sm outline-none focus:border-pine"
              placeholder="比如:数据库原理 期末复习题"
            />
            <div className="mt-4 text-sm font-medium">谁可以看到?</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {VIS_OPTIONS.map((o) => (
                <button
                  key={o.v}
                  onClick={() => setVisibility(o.v)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    visibility === o.v ? "border-pine bg-pine-soft" : "border-line hover:border-line-strong"
                  }`}
                >
                  <div className="text-sm font-medium">{o.label}</div>
                  <div className="mt-0.5 text-xs text-ink-soft">{o.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {questions.map((q, i) => (
              <QuestionEditCard key={i} q={q} index={i} onPatch={patchQ} onDelete={deleteQ} />
            ))}
          </div>

          <button
            onClick={() =>
              setQuestions((qs) => [...qs, { type: "single", stem: "", options: ["", "", "", ""], answer: "" }])
            }
            className="mt-4 text-sm text-pine hover:underline"
          >
            + 手动加一题
          </button>

          {/* 底部固定保存条 */}
          <div className="sticky bottom-0 -mx-4 mt-6 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink-soft">{questions.length} 道题 · {VIS_OPTIONS.find((o) => o.v === visibility)?.label}</span>
              <button
                onClick={save}
                disabled={step === "saving" || questions.length === 0 || !title.trim()}
                className="rounded-lg bg-pine px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-pine-deep disabled:opacity-50"
              >
                {step === "saving" ? "保存中…" : "保存,开刷 →"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
