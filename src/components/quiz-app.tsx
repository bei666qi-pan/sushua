"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Question, Visibility } from "@/lib/types";
import { TYPE_LABEL } from "@/lib/types";
import { AiExplain } from "./ai-explain";
import { forgetBank, rememberBank } from "./my-banks";

interface BankData {
  bank: { slug: string; title: string; visibility: Visibility; created_at: string };
  questions: Question[];
  isOwner: boolean;
}

interface AnswerRec {
  sel: string;
  correct: boolean | null; // null = 简答/填空未自评或题目无答案
}

interface Progress {
  shuffle: boolean;
  order: number[];
  idx: number;
  answers: Record<number, AnswerRec>;
  wrong: number[];
  onlyWrong: boolean;
  wrongRound?: number[]; // 本轮重刷错题的快照:刷对后题目不会立刻从列表消失
}

type Tab = "quiz" | "memo" | "wrong" | "search";

const VIS_LABEL: Record<Visibility, string> = { private: "私有", unlisted: "链接可见", public: "公开" };

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeJudge(s: string): string {
  const t = s.trim().toUpperCase();
  if (["对", "√", "正确", "T", "TRUE"].includes(t)) return "对";
  if (["错", "×", "X", "错误", "F", "FALSE"].includes(t)) return "错";
  return t;
}

export function QuizApp({ slug }: { slug: string }) {
  const router = useRouter();
  const [data, setData] = useState<BankData | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [tab, setTab] = useState<Tab>("quiz");
  const [prog, setProg] = useState<Progress | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [pendingSel, setPendingSel] = useState<string[]>([]); // 多选暂存
  const [fillInput, setFillInput] = useState("");
  const [createdBanner, setCreatedBanner] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [answersOnly, setAnswersOnly] = useState(false);
  const [memoVisible, setMemoVisible] = useState(60);
  const [keyword, setKeyword] = useState("");
  const [copied, setCopied] = useState(false);
  const [streak, setStreak] = useState(0); // 连对计数(仅当前会话,不落盘)
  const [lastAnsweredId, setLastAnsweredId] = useState<number | null>(null);
  const progKey = `sushua:prog:${slug}`;

  // ---------- 加载题库(一次性全部下发,切题零请求) ----------
  useEffect(() => {
    const ownerKey = localStorage.getItem(`sushua:owner:${slug}`) ?? "";
    fetch(`/api/banks/${slug}`, { headers: ownerKey ? { "x-owner-key": ownerKey } : {} })
      .then(async (res) => {
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "加载失败");
        setData(d);
        rememberBank({ slug, title: d.bank.title, count: d.questions.length });
        // 恢复/初始化进度(按题库隔离,断点续刷)
        let p: Progress | null = null;
        try {
          p = JSON.parse(localStorage.getItem(`sushua:prog:${slug}`) ?? "null");
        } catch {}
        const ids = (d.questions as Question[]).map((q) => q.id);
        const idSet = new Set(ids);
        if (!p || !Array.isArray(p.order) || p.order.some((id) => !idSet.has(id)) || p.order.length !== ids.length) {
          p = { shuffle: false, order: ids, idx: 0, answers: {}, wrong: [], onlyWrong: false };
        }
        setProg(p);
      })
      .catch((e) => setLoadErr(e.message));
    if (new URLSearchParams(window.location.search).get("created") === "1") {
      setCreatedBanner(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const persist = useCallback(
    (p: Progress) => {
      setProg(p);
      localStorage.setItem(progKey, JSON.stringify(p));
    },
    [progKey]
  );

  const qById = useMemo(() => {
    const m = new Map<number, Question>();
    data?.questions.forEach((q) => m.set(q.id, q));
    return m;
  }, [data]);

  const [chapterFilter, setChapterFilter] = useState<string>("");
  const chapters = useMemo(() => {
    const set = new Set<string>();
    data?.questions.forEach((q) => q.chapter && set.add(q.chapter));
    return [...set];
  }, [data]);
  const chapterCounts = useMemo(() => {
    const m: Record<string, number> = {};
    data?.questions.forEach((q) => {
      if (q.chapter) m[q.chapter] = (m[q.chapter] ?? 0) + 1;
    });
    return m;
  }, [data]);

  // 当前刷题序列(全部 or 只刷错题 · 可叠加章节筛选)
  const quizList = useMemo(() => {
    if (!prog) return [];
    const wrongPool = prog.wrongRound ?? prog.wrong;
    let ids = prog.onlyWrong ? prog.order.filter((id) => wrongPool.includes(id)) : prog.order;
    if (chapterFilter) ids = ids.filter((id) => qById.get(id)?.chapter === chapterFilter);
    return ids;
  }, [prog, chapterFilter, qById]);

  const curId = quizList[Math.min(prog?.idx ?? 0, Math.max(quizList.length - 1, 0))];
  const curQ = curId !== undefined ? qById.get(curId) : undefined;
  const curRec = curQ && prog ? prog.answers[curQ.id] : undefined;

  const doneCount = useMemo(() => (prog ? quizList.filter((id) => prog.answers[id]).length : 0), [prog, quizList]);
  const correctCount = useMemo(
    () => (prog ? quizList.filter((id) => prog.answers[id]?.correct === true).length : 0),
    [prog, quizList]
  );

  // 本章/本轮是否刷完 + 下一章
  const chapterDone = quizList.length > 0 && doneCount === quizList.length;
  const wrongInList = useMemo(
    () => (prog ? quizList.filter((id) => prog.answers[id]?.correct === false) : []),
    [prog, quizList]
  );
  const nextChapter = chapterFilter ? chapters[chapters.indexOf(chapterFilter) + 1] : undefined;

  // ---------- 判分 ----------
  const grade = useCallback(
    (q: Question, sel: string): boolean | null => {
      const ans = q.answer.trim();
      if (!ans) return null;
      if (q.type === "single") return sel === ans.toUpperCase();
      if (q.type === "multiple")
        return sel.split("").sort().join("") === ans.toUpperCase().replace(/[^A-H]/g, "").split("").sort().join("");
      if (q.type === "judge") return normalizeJudge(sel) === normalizeJudge(ans);
      return null;
    },
    []
  );

  const submitAnswer = useCallback(
    (q: Question, sel: string, selfCorrect?: boolean) => {
      if (!prog) return;
      const correct = selfCorrect !== undefined ? selfCorrect : grade(q, sel);
      const answers = { ...prog.answers, [q.id]: { sel, correct } };
      let wrong = prog.wrong;
      if (correct === false && !wrong.includes(q.id)) wrong = [...wrong, q.id];
      if (correct === true && prog.onlyWrong) wrong = wrong.filter((id) => id !== q.id); // 错题刷对了就移出
      if (correct === true) setStreak((s) => s + 1);
      else if (correct === false) setStreak(0);
      setLastAnsweredId(q.id);
      persist({ ...prog, answers, wrong });
    },
    [prog, grade, persist]
  );

  const goto = useCallback(
    (idx: number) => {
      if (!prog) return;
      const clamped = Math.max(0, Math.min(idx, quizList.length - 1));
      persist({ ...prog, idx: clamped });
      setPendingSel([]);
      setFillInput("");
    },
    [prog, quizList.length, persist]
  );

  const gotoNextChapter = useCallback(() => {
    if (!nextChapter || !prog) return;
    setChapterFilter(nextChapter);
    persist({ ...prog, idx: 0 });
    setPendingSel([]);
    setFillInput("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [nextChapter, prog, persist]);

  // 重刷错题:快照本轮题目并清掉旧作答,让这些题可以真正重新作答
  const startWrongRedo = useCallback(
    (ids: number[]) => {
      if (!prog || ids.length === 0) return;
      const answers = { ...prog.answers };
      ids.forEach((id) => delete answers[id]);
      persist({ ...prog, answers, onlyWrong: true, wrongRound: ids, idx: 0 });
      setStreak(0);
      setPendingSel([]);
      setFillInput("");
    },
    [prog, persist]
  );

  const selectOption = useCallback(
    (letter: string) => {
      if (!curQ || !prog || curRec) return;
      if (curQ.type === "single") submitAnswer(curQ, letter);
      else if (curQ.type === "multiple")
        setPendingSel((s) => (s.includes(letter) ? s.filter((x) => x !== letter) : [...s, letter].sort()));
    },
    [curQ, prog, curRec, submitAnswer]
  );

  // ---------- 键盘快捷键:1-4 选项、←→ 切题、Enter 下一题 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (tab !== "quiz" || !curQ) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
        if (e.key === "Enter" && (curQ.type === "fill" || curQ.type === "short") && !revealed.has(curQ.id) && !curRec) {
          e.preventDefault();
          setRevealed((s) => new Set(s).add(curQ.id));
          (target as HTMLInputElement).blur();
        }
        return;
      }
      const k = e.key;
      if (k === "ArrowLeft") return goto((prog?.idx ?? 0) - 1);
      if (k === "ArrowRight") return goto((prog?.idx ?? 0) + 1);
      if (k === "Enter") {
        e.preventDefault();
        if (curQ.type === "multiple" && !curRec && pendingSel.length) return submitAnswer(curQ, pendingSel.join(""));
        if ((curQ.type === "fill" || curQ.type === "short") && !curRec && !revealed.has(curQ.id))
          return setRevealed((s) => new Set(s).add(curQ.id));
        if (curRec) {
          // 章节刷完且在最后一题:Enter 直接进下一章
          if (prog && prog.idx >= quizList.length - 1 && chapterDone && nextChapter && !prog.onlyWrong)
            return gotoNextChapter();
          return goto((prog?.idx ?? 0) + 1);
        }
        return;
      }
      if (curQ.type === "judge" && !curRec) {
        if (k === "1") return submitAnswer(curQ, "对");
        if (k === "2") return submitAnswer(curQ, "错");
        return;
      }
      if (/^[1-8]$/.test(k)) {
        const i = Number(k) - 1;
        if (i < curQ.options.length) selectOption(String.fromCharCode(65 + i));
      } else if (/^[a-hA-H]$/.test(k)) {
        const letter = k.toUpperCase();
        if (letter.charCodeAt(0) - 65 < curQ.options.length) selectOption(letter);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, curQ, curRec, prog, pendingSel, revealed, goto, selectOption, submitAnswer, quizList.length, chapterDone, nextChapter, gotoNextChapter]);

  // ---------- 管理操作 ----------
  const ownerKey = typeof window !== "undefined" ? localStorage.getItem(`sushua:owner:${slug}`) ?? "" : "";
  const manage = async (body: { title?: string; visibility?: Visibility }) => {
    const res = await fetch(`/api/banks/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-owner-key": ownerKey },
      body: JSON.stringify(body),
    });
    if (res.ok && data) {
      setData({ ...data, bank: { ...data.bank, ...body } as BankData["bank"] });
      if (body.title) rememberBank({ slug, title: body.title, count: data.questions.length });
    }
  };
  const removeBank = async () => {
    if (!confirm("确定删除整个题库吗?不可恢复。")) return;
    const res = await fetch(`/api/banks/${slug}`, { method: "DELETE", headers: { "x-owner-key": ownerKey } });
    if (res.ok) {
      forgetBank(slug);
      localStorage.removeItem(progKey);
      router.push("/");
    }
  };

  // ---------- 渲染 ----------
  if (loadErr) {
    return (
      <div className="mx-auto max-w-lg px-4 py-24 text-center">
        <div className="font-display text-3xl">🔒</div>
        <p className="mt-4 font-medium">{loadErr}</p>
        <p className="mt-2 text-sm text-ink-soft">如果这是你的题库,请用创建时的那台设备/浏览器打开。</p>
      </div>
    );
  }
  if (!data || !prog) {
    return (
      <div className="flex justify-center py-24">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-strong border-t-pine" />
      </div>
    );
  }

  const { bank, questions } = data;
  const searchResults = keyword.trim()
    ? questions.filter((q) =>
        (q.stem + q.options.join(" ") + q.answer).toLowerCase().includes(keyword.trim().toLowerCase())
      )
    : [];

  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/b/${slug}` : "";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6 lg:px-8">
      {createdBanner && (
        <div className="mt-4 rounded-xl border border-pine/30 bg-pine-soft px-4 py-3 text-sm">
          <span className="font-medium text-pine">题库创建成功!</span> 管理凭证已存在本机浏览器。
          {bank.visibility !== "private" && (
            <button
              onClick={() => {
                navigator.clipboard?.writeText(shareUrl);
                setCopied(true);
              }}
              className="ml-2 text-pine underline underline-offset-2"
            >
              {copied ? "已复制链接 ✓" : "复制分享链接"}
            </button>
          )}
        </div>
      )}

      {/* 题库头 */}
      <div className="pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold leading-snug sm:text-3xl">{bank.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-soft">
              <span className="rounded-full border border-line px-2 py-0.5">{VIS_LABEL[bank.visibility]}</span>
              <span>{questions.length} 题</span>
              <span>
                已刷 {doneCount} · 正确率 {doneCount ? Math.round((correctCount / doneCount) * 100) : 0}%
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {bank.visibility !== "private" && (
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(shareUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs hover:border-pine hover:text-pine"
              >
                {copied ? "已复制 ✓" : "分享"}
              </button>
            )}
            {data.isOwner && (
              <button
                onClick={() => setShowManage((s) => !s)}
                className="rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs hover:border-pine hover:text-pine"
              >
                管理
              </button>
            )}
          </div>
        </div>

        {showManage && data.isOwner && (
          <div className="fade-up mt-4 rounded-xl border border-line bg-card p-4">
            <label className="text-xs font-medium text-ink-soft">题库名称</label>
            <div className="mt-1 flex gap-2">
              <input
                defaultValue={bank.title}
                id="rename-input"
                className="flex-1 rounded-lg border border-line-strong bg-paper px-3 py-1.5 text-sm outline-none focus:border-pine"
              />
              <button
                onClick={() => {
                  const v = (document.getElementById("rename-input") as HTMLInputElement).value.trim();
                  if (v) manage({ title: v });
                }}
                className="rounded-lg bg-pine px-3 py-1.5 text-sm text-white hover:bg-pine-deep"
              >
                改名
              </button>
            </div>
            <div className="mt-3 text-xs font-medium text-ink-soft">可见性</div>
            <div className="mt-1 flex gap-2">
              {(["private", "unlisted", "public"] as Visibility[]).map((v) => (
                <button
                  key={v}
                  onClick={() => manage({ visibility: v })}
                  className={`rounded-lg border px-3 py-1.5 text-xs ${
                    bank.visibility === v ? "border-pine bg-pine-soft text-pine" : "border-line hover:border-line-strong"
                  }`}
                >
                  {VIS_LABEL[v]}
                </button>
              ))}
            </div>
            <button onClick={removeBank} className="mt-4 text-xs text-bad hover:underline">
              删除整个题库
            </button>
          </div>
        )}
      </div>

      {/* Tab 栏 */}
      <div className="sticky top-14 z-30 -mx-4 mt-5 border-b border-line bg-paper/95 px-4 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex gap-1">
          {(
            [
              ["quiz", "速刷"],
              ["memo", "速记"],
              ["wrong", `错题本${prog.wrong.length ? ` ${prog.wrong.length}` : ""}`],
              ["search", "搜索"],
            ] as Array<[Tab, string]>
          ).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`border-b-2 px-3 py-2.5 text-sm transition-colors ${
                tab === t ? "border-pine font-medium text-pine" : "border-transparent text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ============ 速刷 ============ */}
      {tab === "quiz" && (
        <div className="fade-up pt-5">
          {/* 控制条 */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const ids = questions.map((q) => q.id);
                  persist({
                    ...prog,
                    shuffle: !prog.shuffle,
                    order: !prog.shuffle ? shuffled(ids) : ids,
                    idx: 0,
                  });
                }}
                className={`rounded-lg border px-2.5 py-1 ${
                  prog.shuffle ? "border-pine bg-pine-soft text-pine" : "border-line-strong bg-card text-ink-soft"
                }`}
              >
                {prog.shuffle ? "乱序中" : "顺序刷"}
              </button>
              {prog.onlyWrong && (
                <button
                  onClick={() => persist({ ...prog, onlyWrong: false, wrongRound: undefined, idx: 0 })}
                  className="rounded-lg border border-bad/40 bg-bad-soft px-2.5 py-1 text-bad"
                >
                  只刷错题中 · 退出
                </button>
              )}
              {chapters.length > 0 && (
                <ChapterSelect
                  chapters={chapters}
                  counts={chapterCounts}
                  value={chapterFilter}
                  onChange={(c) => {
                    setChapterFilter(c);
                    persist({ ...prog, idx: 0 });
                  }}
                />
              )}
            </div>
            <button
              onClick={() => {
                if (!confirm("清空本题库的刷题进度,重新开始?")) return;
                setStreak(0);
                persist({
                  ...prog,
                  idx: 0,
                  answers: {},
                  wrong: [],
                  onlyWrong: false,
                  wrongRound: undefined,
                  order: prog.shuffle ? shuffled(questions.map((q) => q.id)) : questions.map((q) => q.id),
                });
              }}
              className="text-ink-faint hover:text-bad"
            >
              重新开始
            </button>
          </div>

          {/* 进度条 */}
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line">
            <div
              className={`h-full rounded-full transition-all duration-500 ${chapterDone ? "bg-ok" : "bg-pine"}`}
              style={{ width: `${quizList.length ? (doneCount / quizList.length) * 100 : 0}%` }}
            />
          </div>

          {quizList.length === 0 ? (
            prog.onlyWrong ? (
              <div className="fade-up py-16 text-center">
                <p className="text-sm font-medium text-pine">错题都消灭了 ✓</p>
                <button
                  onClick={() => persist({ ...prog, onlyWrong: false, wrongRound: undefined, idx: 0 })}
                  className="mt-3 text-sm text-pine underline underline-offset-2"
                >
                  回到全部题目
                </button>
              </div>
            ) : (
              <p className="py-16 text-center text-sm text-ink-soft">没有可刷的题</p>
            )
          ) : (
            curQ && (
              <>
                <QuestionCard
                  key={curQ.id}
                  q={curQ}
                  index={prog.idx}
                  total={quizList.length}
                  rec={curRec}
                  pendingSel={pendingSel}
                  revealed={revealed.has(curQ.id)}
                  fillInput={fillInput}
                  streak={streak}
                  isLastAnswered={curQ.id === lastAnsweredId}
                  nextChapter={!prog.onlyWrong && chapterDone ? nextChapter : undefined}
                  onNextChapter={gotoNextChapter}
                  onFillInput={setFillInput}
                  onSelect={selectOption}
                  onConfirmMulti={() => pendingSel.length && submitAnswer(curQ, pendingSel.join(""))}
                  onReveal={() => setRevealed((s) => new Set(s).add(curQ.id))}
                  onSelfJudge={(ok) => submitAnswer(curQ, fillInput, ok)}
                  onPrev={() => goto(prog.idx - 1)}
                  onNext={() => goto(prog.idx + 1)}
                />

                {/* 刷完本章/本轮:小结卡片 + 下一章入口 */}
                {chapterDone && (
                  <div className="pop-in mt-4 rounded-2xl border border-pine/25 bg-pine-soft px-5 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-pine">
                          {prog.onlyWrong
                            ? "这轮错题刷完了"
                            : chapterFilter
                              ? `「${chapterFilter}」刷完了`
                              : "整套题刷完了"}
                          {correctCount === quizList.length && " · 全对 👏"}
                        </div>
                        <div className="mt-1 text-xs text-ink-soft">
                          共 {quizList.length} 题 · 正确率 {Math.round((correctCount / quizList.length) * 100)}%
                          {wrongInList.length > 0 && ` · 答错 ${wrongInList.length} 题`}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {wrongInList.length > 0 && (
                          <button
                            onClick={() => startWrongRedo(wrongInList)}
                            className="rounded-lg border border-bad/40 bg-card px-3 py-1.5 text-xs text-bad hover:bg-bad-soft"
                          >
                            重刷答错的 {wrongInList.length} 题
                          </button>
                        )}
                        {prog.onlyWrong ? (
                          <button
                            onClick={() => persist({ ...prog, onlyWrong: false, wrongRound: undefined, idx: 0 })}
                            className="rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs hover:border-pine hover:text-pine"
                          >
                            回到全部题目
                          </button>
                        ) : nextChapter ? (
                          <button
                            onClick={gotoNextChapter}
                            className="rounded-lg bg-pine px-4 py-1.5 text-xs font-medium text-white hover:bg-pine-deep"
                          >
                            下一章:{nextChapter.length > 12 ? `${nextChapter.slice(0, 12)}…` : nextChapter} →
                          </button>
                        ) : chapterFilter ? (
                          <span className="text-xs text-ink-faint">已是最后一章</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}

      {/* ============ 速记 ============ */}
      {tab === "memo" && (
        <div className="fade-up pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-ink-soft">题目答案同屏,上下滑着背</p>
            <div className="flex items-center gap-2">
              {chapters.length > 0 && (
                <ChapterSelect chapters={chapters} counts={chapterCounts} value={chapterFilter} onChange={setChapterFilter} />
              )}
              <button
                onClick={() => setAnswersOnly((s) => !s)}
                className={`rounded-lg border px-2.5 py-1 text-xs ${
                  answersOnly ? "border-pine bg-pine-soft text-pine" : "border-line-strong bg-card text-ink-soft"
                }`}
              >
                {answersOnly ? "只看答案中" : "只看答案"}
              </button>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {questions
              .filter((q) => !chapterFilter || q.chapter === chapterFilter)
              .slice(0, memoVisible)
              .map((q, i) =>
                answersOnly ? (
                  <div key={q.id} className="flex gap-3 rounded-lg border border-line bg-card px-3 py-2 text-sm">
                    <span className="shrink-0 font-medium text-ink-faint">{i + 1}.</span>
                    <span className="font-medium text-pine">{formatAnswer(q)}</span>
                  </div>
                ) : (
                  <MemoCard key={q.id} q={q} index={i} />
                )
              )}
          </div>
          {memoVisible < questions.length && (
            <button
              onClick={() => setMemoVisible((v) => v + 100)}
              className="mt-4 w-full rounded-lg border border-line bg-card py-2.5 text-sm text-ink-soft hover:border-pine hover:text-pine"
            >
              继续加载({memoVisible}/{questions.length})
            </button>
          )}
        </div>
      )}

      {/* ============ 错题本 ============ */}
      {tab === "wrong" && (
        <div className="fade-up pt-5">
          {prog.wrong.length === 0 ? (
            <p className="py-16 text-center text-sm text-ink-soft">还没有错题,继续保持 ✌️</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-ink-soft">共 {prog.wrong.length} 道错题</p>
                <button
                  onClick={() => {
                    setChapterFilter("");
                    startWrongRedo(prog.wrong);
                    setTab("quiz");
                  }}
                  className="rounded-lg bg-pine px-4 py-1.5 text-sm font-medium text-white hover:bg-pine-deep"
                >
                  重刷错题 →
                </button>
              </div>
              <div className="mt-4 space-y-3">
                {prog.wrong.map((id) => {
                  const q = qById.get(id);
                  if (!q) return null;
                  return (
                    <div key={id} className="rounded-xl border border-line bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm leading-relaxed">
                          <span className="mr-1.5 rounded bg-bad-soft px-1.5 py-0.5 text-xs text-bad">
                            {TYPE_LABEL[q.type]}
                          </span>
                          {q.stem}
                        </div>
                        <button
                          onClick={() => persist({ ...prog, wrong: prog.wrong.filter((w) => w !== id) })}
                          className="shrink-0 text-xs text-ink-faint hover:text-bad"
                        >
                          移除
                        </button>
                      </div>
                      <div className="mt-2 text-sm">
                        <span className="text-ink-faint">答案:</span>{" "}
                        <span className="font-medium text-pine">{formatAnswer(q)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ============ 搜索 ============ */}
      {tab === "search" && (
        <div className="fade-up pt-5">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="输入关键词,搜题干 / 选项 / 答案"
            autoFocus
            className="w-full rounded-xl border border-line-strong bg-card px-4 py-3 text-sm outline-none focus:border-pine"
          />
          <div className="mt-4 space-y-3">
            {keyword.trim() && searchResults.length === 0 && (
              <p className="py-10 text-center text-sm text-ink-soft">没搜到相关题目</p>
            )}
            {searchResults.slice(0, 50).map((q) => {
              const pos = prog.order.indexOf(q.id);
              return (
                <button
                  key={q.id}
                  onClick={() => {
                    persist({ ...prog, onlyWrong: false, idx: Math.max(pos, 0) });
                    setTab("quiz");
                  }}
                  className="block w-full rounded-xl border border-line bg-card p-4 text-left transition-colors hover:border-pine"
                >
                  <div className="line-clamp-2 text-sm leading-relaxed">
                    <span className="mr-1.5 rounded bg-pine-soft px-1.5 py-0.5 text-xs text-pine">
                      {TYPE_LABEL[q.type]}
                    </span>
                    {q.stem}
                  </div>
                  <div className="mt-1.5 text-xs text-ink-faint">
                    答案:{formatAnswer(q)} · 点击跳到这题
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function formatAnswer(q: Question): string {
  if (!q.answer.trim()) return "(未提供)";
  if ((q.type === "single" || q.type === "multiple") && /^[A-H]+$/i.test(q.answer.trim())) {
    return q.answer
      .trim()
      .toUpperCase()
      .split("")
      .map((c) => {
        const i = c.charCodeAt(0) - 65;
        return q.options[i] ? `${c}. ${q.options[i]}` : c;
      })
      .join("  ");
  }
  return q.answer;
}

/** 章节选择:极简下拉,替代原生 select,同时用于速刷/速记两个 tab */
function ChapterSelect({
  chapters,
  counts,
  value,
  onChange,
}: {
  chapters: string[];
  counts: Record<string, number>;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex max-w-[42vw] items-center gap-1 rounded-lg border px-2.5 py-1 text-xs sm:max-w-[240px] ${
          value ? "border-pine bg-pine-soft text-pine" : "border-line-strong bg-card text-ink-soft"
        }`}
      >
        <span className="truncate">{value || "全部章节"}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="fade-up absolute left-0 top-full z-40 mt-1.5 max-h-72 w-72 max-w-[85vw] overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-pop">
          <button
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
              !value ? "bg-pine-soft text-pine" : "hover:bg-paper"
            }`}
          >
            <span>全部章节</span>
            <span className="shrink-0 text-xs text-ink-faint">{total}</span>
          </button>
          {chapters.map((c) => (
            <button
              key={c}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                c === value ? "bg-pine-soft text-pine" : "hover:bg-paper"
              }`}
            >
              <span className="truncate">{c}</span>
              <span className="shrink-0 text-xs text-ink-faint">{counts[c] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 速记卡片 */
function MemoCard({ q, index }: { q: Question; index: number }) {
  return (
    <div className="rounded-xl border border-line bg-card p-4">
      <div className="text-sm leading-relaxed">
        <span className="mr-1.5 text-xs text-ink-faint">
          {index + 1} · {TYPE_LABEL[q.type]}
        </span>
        {q.stem}
      </div>
      {q.options.length > 0 && (
        <div className="mt-2 space-y-1 text-sm text-ink-soft">
          {q.options.map((o, i) => {
            const letter = String.fromCharCode(65 + i);
            const hit = q.answer.toUpperCase().includes(letter);
            return (
              <div key={i} className={hit ? "font-medium text-pine" : ""}>
                {letter}. {o}
                {hit && " ✓"}
              </div>
            );
          })}
        </div>
      )}
      {(q.options.length === 0 || q.type === "judge") && (
        <div className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-sm font-medium text-ok">{formatAnswer(q)}</div>
      )}
      {q.explanation && <p className="mt-2 text-xs leading-relaxed text-ink-soft">解析:{q.explanation}</p>}
      <AiExplain stem={q.stem} options={q.options} answer={q.answer} type={q.type} />
    </div>
  );
}

/** 速刷题卡 */
function QuestionCard(props: {
  q: Question;
  index: number;
  total: number;
  rec?: AnswerRec;
  pendingSel: string[];
  revealed: boolean;
  fillInput: string;
  streak: number;
  isLastAnswered: boolean;
  nextChapter?: string;
  onNextChapter?: () => void;
  onFillInput: (s: string) => void;
  onSelect: (letter: string) => void;
  onConfirmMulti: () => void;
  onReveal: () => void;
  onSelfJudge: (ok: boolean) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { q, index, total, rec, pendingSel, revealed, fillInput } = props;
  const answered = !!rec;
  const ansLetters = q.answer.trim().toUpperCase();

  return (
    <div className="fade-up mt-4">
      <div className="rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6">
        <div className="flex items-center gap-1.5 overflow-hidden text-xs text-ink-faint">
          <span className="shrink-0 font-medium text-ink-soft">
            {index + 1}/{total}
          </span>
          <span className="shrink-0">·</span>
          <span className="shrink-0">{TYPE_LABEL[q.type]}</span>
          {q.chapter && (
            <>
              <span className="shrink-0">·</span>
              <span className="truncate">{q.chapter}</span>
            </>
          )}
        </div>
        <div className="mt-3 text-base leading-relaxed sm:text-lg">{q.stem}</div>

        {/* 选择题选项 */}
        {(q.type === "single" || q.type === "multiple") && (
          <div className="mt-4 space-y-2">
            {q.options.map((opt, i) => {
              const letter = String.fromCharCode(65 + i);
              const isSel = answered ? rec!.sel.includes(letter) : pendingSel.includes(letter);
              const isAns = ansLetters.includes(letter);
              let cls = "border-line bg-paper hover:border-pine";
              if (answered) {
                if (isAns) cls = "border-ok bg-ok-soft";
                else if (isSel) cls = "border-bad bg-bad-soft";
                else cls = "border-line bg-paper opacity-60";
              } else if (isSel) {
                cls = "border-pine bg-pine-soft";
              }
              return (
                <button
                  key={i}
                  disabled={answered}
                  onClick={() => props.onSelect(letter)}
                  className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors sm:text-base ${cls}`}
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
                      answered && isAns
                        ? "border-ok bg-ok text-white"
                        : answered && isSel
                          ? "border-bad bg-bad text-white"
                          : isSel
                            ? "border-pine bg-pine text-white"
                            : "border-line-strong text-ink-soft"
                    }`}
                  >
                    {letter}
                  </span>
                  <span className="leading-relaxed">{opt}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 判断题 */}
        {q.type === "judge" && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            {(["对", "错"] as const).map((v, i) => {
              const isSel = answered && normalizeJudge(rec!.sel) === v;
              const isAns = normalizeJudge(q.answer) === v;
              let cls = "border-line bg-paper hover:border-pine";
              if (answered) {
                if (isAns) cls = "border-ok bg-ok-soft";
                else if (isSel) cls = "border-bad bg-bad-soft";
                else cls = "border-line bg-paper opacity-60";
              }
              return (
                <button
                  key={v}
                  disabled={answered}
                  onClick={() => props.onSelect(v)}
                  className={`rounded-xl border py-4 text-lg font-medium transition-colors ${cls}`}
                >
                  {v === "对" ? "✓ 对" : "✗ 错"}
                  <span className="ml-2 text-xs text-ink-faint">按 {i + 1}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 填空 / 简答 */}
        {(q.type === "fill" || q.type === "short") && !answered && (
          <div className="mt-4">
            {q.type === "fill" ? (
              <input
                value={fillInput}
                onChange={(e) => props.onFillInput(e.target.value)}
                placeholder="先自己答一下(可留空)"
                className="w-full rounded-xl border border-line-strong bg-paper px-4 py-3 text-sm outline-none focus:border-pine"
              />
            ) : (
              <textarea
                value={fillInput}
                onChange={(e) => props.onFillInput(e.target.value)}
                rows={3}
                placeholder="先在心里或这里答一下(可留空)"
                className="w-full resize-y rounded-xl border border-line-strong bg-paper px-4 py-3 text-sm outline-none focus:border-pine"
              />
            )}
            {!revealed ? (
              <button
                onClick={props.onReveal}
                className="mt-3 rounded-lg bg-pine px-5 py-2 text-sm font-medium text-white hover:bg-pine-deep"
              >
                对答案(Enter)
              </button>
            ) : (
              <div className="fade-up mt-3">
                <div className="rounded-xl bg-ok-soft px-4 py-3 text-sm">
                  <span className="text-xs text-ink-soft">参考答案</span>
                  <div className="mt-1 whitespace-pre-wrap font-medium text-ok">{q.answer || "(未提供)"}</div>
                </div>
                <div className="mt-3 flex gap-3">
                  <button
                    onClick={() => props.onSelfJudge(true)}
                    className="flex-1 rounded-lg border border-ok bg-ok-soft py-2 text-sm font-medium text-ok hover:bg-ok hover:text-white"
                  >
                    我答对了
                  </button>
                  <button
                    onClick={() => props.onSelfJudge(false)}
                    className="flex-1 rounded-lg border border-bad bg-bad-soft py-2 text-sm font-medium text-bad hover:bg-bad hover:text-white"
                  >
                    答错了,记入错题
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 作答结果 + 解析 */}
        {answered && (
          <div className="fade-up mt-4">
            <div
              className={`pop-in rounded-xl px-4 py-3 text-sm font-medium ${
                rec!.correct === true
                  ? "bg-ok-soft text-ok"
                  : rec!.correct === false
                    ? "bg-bad-soft text-bad"
                    : "bg-warn-soft text-ink-soft"
              }`}
            >
              {rec!.correct === true
                ? `回答正确 🎉${props.isLastAnswered && props.streak >= 3 ? ` 已连对 ${props.streak} 题` : ""}`
                : rec!.correct === false
                  ? `答错了,正确答案:${formatAnswer(q)}`
                  : `参考答案:${formatAnswer(q)}`}
            </div>
            {q.explanation && (
              <p className="mt-3 rounded-lg bg-paper px-4 py-3 text-sm leading-relaxed text-ink-soft">
                解析:{q.explanation}
              </p>
            )}
            <AiExplain
              stem={q.stem}
              options={q.options}
              answer={q.answer}
              type={q.type}
              userChoice={rec?.correct === false ? rec.sel : undefined}
            />
          </div>
        )}
      </div>

      {/* 底部切题:多选未确认时,这颗按钮先充当"确认答案",确认后才变回"下一题" */}
      {(() => {
        const needsConfirm = q.type === "multiple" && !answered;
        const atEnd = index >= total - 1;
        // 章节刷完且在最后一题:这颗按钮变成"进入下一章"
        const showNextChapter = atEnd && answered && !!props.nextChapter && !!props.onNextChapter;
        return (
          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={props.onPrev}
              disabled={index === 0}
              className="rounded-lg border border-line-strong bg-card px-5 py-2.5 text-sm disabled:opacity-40"
            >
              ← 上一题
            </button>
            <button
              onClick={needsConfirm ? props.onConfirmMulti : showNextChapter ? props.onNextChapter : props.onNext}
              disabled={needsConfirm ? pendingSel.length === 0 : showNextChapter ? false : atEnd}
              className="rounded-lg bg-pine px-6 py-2.5 text-sm font-medium text-white hover:bg-pine-deep disabled:opacity-40"
            >
              {needsConfirm ? "确认答案(Enter)" : showNextChapter ? "进入下一章 →" : "下一题 →"}
            </button>
          </div>
        );
      })()}
    </div>
  );
}
