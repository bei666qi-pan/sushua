import type { DraftQuestion, QType } from "./types";

/**
 * 规则切题管线:纯正则,零 AI 成本。
 * 识别:题号、选项 A-F、答案(字母/对错)、解析、章节题型提示。
 * 规则解析不出的段落进入 leftovers,由上层决定是否调 AI 兜底。
 */

export interface ParseOutput {
  questions: DraftQuestion[];
  leftovers: string[];
}

const FULL_TO_HALF: Record<string, string> = {
  "Ａ": "A", "Ｂ": "B", "Ｃ": "C", "Ｄ": "D", "Ｅ": "E", "Ｆ": "F",
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  "．": ".", "：": ":", "（": "(", "）": ")", "　": " ",
};

function normalize(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n");
  s = s.replace(/[ＡＢＣＤＥＦ０-９．：（）　]/g, (c) => FULL_TO_HALF[c] ?? c);
  // 把行内选项 "A. xx B. yy" 拆行,便于统一按行解析
  s = s
    .split("\n")
    .map((line) => line.replace(/(?<=\S)\s+(?=[A-F][..、,]\s*\S)/g, "\n"))
    .join("\n");
  return s;
}

/** 章节标题 → 题型提示,如 "一、单选题" */
function sectionHint(line: string): QType | null {
  if (!/^[\s]*[一二三四五六七八九十0-9]+\s*[、..]|^【.*】$/.test(line) && !/题[::]?\s*$/.test(line)) {
    if (!/^(单选|多选|判断|填空|简答|选择|不定项)/.test(line.trim())) return null;
  }
  const t = line;
  if (/多选|不定项/.test(t)) return "multiple";
  if (/单选|选择题/.test(t)) return "single";
  if (/判断/.test(t)) return "judge";
  if (/填空/.test(t)) return "fill";
  if (/简答|问答|论述|名词解释/.test(t)) return "short";
  return null;
}

const Q_START = /^\s*(?:第?\s*(\d{1,3})\s*题|(\d{1,3}))\s*[..、、).::]\s*/;
const OPTION_RE = /^\s*\(?([A-F])[))..、、::]\s*(.+?)\s*$/;
const ANSWER_RE = /^[\s ]*(?:【\s*(?:参考)?答案\s*】|(?:参考|正确)?答案)\s*[::]?\s*(.*)$/;
const EXPLAIN_RE = /^[\s ]*(?:【\s*解析\s*】|解析|【\s*注释\s*】)\s*[::]?\s*(.*)$/;
/** 行内答案,如 "……。( 答案:B )" 或题干末尾 "(B)" */
const INLINE_ANSWER = /[((]\s*答案\s*[::]?\s*([A-F]+|对|错|√|×|正确|错误|T|F)\s*[))]\s*$/;

function parseAnswerToken(s: string, hasOptions: boolean): { value: string; kind: "letters" | "judge" | "text" } | null {
  const t = s.trim().replace(/\s|,|,|、/g, "").toUpperCase();
  if (!t) return null;
  if (/^[A-F]{1,6}$/.test(t)) return { value: [...new Set(t.split(""))].sort().join(""), kind: "letters" };
  if (/^(对|√|正确|T|TRUE|YES)$/.test(t)) return { value: "对", kind: "judge" };
  if (/^(错|×|X|错误|F|FALSE|NO)$/.test(t)) return { value: "错", kind: "judge" };
  if (!hasOptions) return { value: s.trim(), kind: "text" };
  return null;
}

interface Block { hint: QType | null; lines: string[] }

function splitBlocks(text: string): { blocks: Block[]; preamble: string[] } {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const preamble: string[] = [];
  let cur: Block | null = null;
  let hint: QType | null = null;
  for (const line of lines) {
    const h = sectionHint(line);
    if (h) {
      hint = h;
      continue;
    }
    if (Q_START.test(line)) {
      if (cur) blocks.push(cur);
      cur = { hint, lines: [line.replace(Q_START, "")] };
    } else if (cur) {
      cur.lines.push(line);
    } else if (line.trim()) {
      preamble.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return { blocks, preamble };
}

function parseBlock(block: Block): { q: DraftQuestion | null; confident: boolean } {
  const stemLines: string[] = [];
  const options: string[] = [];
  const optionLetters: string[] = [];
  let answerRaw: string | null = null;
  let explanation = "";
  let mode: "stem" | "options" | "answer" | "explain" = "stem";

  for (const line of block.lines) {
    if (!line.trim()) continue;
    const ans = line.match(ANSWER_RE);
    const exp = line.match(EXPLAIN_RE);
    const opt = line.match(OPTION_RE);
    if (exp) {
      explanation = exp[1];
      mode = "explain";
    } else if (ans && answerRaw === null) {
      answerRaw = ans[1];
      mode = "answer";
    } else if (opt && mode !== "explain") {
      options.push(opt[2]);
      optionLetters.push(opt[1]);
      mode = "options";
    } else if (mode === "stem") {
      stemLines.push(line.trim());
    } else if (mode === "options" && options.length) {
      options[options.length - 1] += " " + line.trim();
    } else if (mode === "answer" && answerRaw !== null) {
      answerRaw += " " + line.trim();
    } else if (mode === "explain") {
      explanation += "\n" + line.trim();
    }
  }

  let stem = stemLines.join("\n").trim();
  if (!stem) return { q: null, confident: false };

  // 题干末尾行内答案
  if (answerRaw === null) {
    const inline = stem.match(INLINE_ANSWER);
    if (inline) {
      answerRaw = inline[1];
      stem = stem.replace(INLINE_ANSWER, "").trim();
    }
  }

  const parsed = answerRaw !== null ? parseAnswerToken(answerRaw, options.length > 0) : null;

  // 题型推断:章节提示优先,其次由结构推断
  let type: QType;
  const blank = /_{2,}|＿{2,}|【\s*】|\(\s*\)/.test(stem) && options.length === 0;
  if (options.length >= 2) {
    if (block.hint === "multiple" || (parsed?.kind === "letters" && parsed.value.length > 1)) type = "multiple";
    else type = "single";
  } else if (block.hint === "judge" || parsed?.kind === "judge") {
    type = "judge";
  } else if (block.hint === "fill" || (blank && (parsed === null || parsed.kind === "text"))) {
    type = "fill";
  } else if (block.hint === "short") {
    type = "short";
  } else if (parsed?.kind === "text") {
    type = (parsed.value.length > 40 ? "short" : "fill");
  } else {
    type = options.length ? "single" : "short";
  }

  let answer = "";
  if (parsed) {
    if (type === "single" || type === "multiple") {
      if (parsed.kind === "letters") answer = parsed.value;
    } else if (type === "judge") {
      answer = parsed.kind === "judge" ? parsed.value : "";
    } else {
      answer = answerRaw?.trim() ?? "";
    }
  }

  const q: DraftQuestion = { type, stem, options, answer, explanation: explanation.trim() || undefined };

  // 置信度:结构完整 + 答案匹配题型
  let confident = true;
  if ((type === "single" || type === "multiple") && (options.length < 2 || !/^[A-F]+$/.test(answer))) confident = answer === "" ? true : /^[A-F]+$/.test(answer);
  if (type === "single" && answer.length > 1) confident = false;
  if (options.length === 1) confident = false;
  return { q, confident };
}

export function parseText(raw: string): ParseOutput {
  const text = normalize(raw);
  const { blocks, preamble } = splitBlocks(text);
  const questions: DraftQuestion[] = [];
  const leftovers: string[] = [];

  for (const b of blocks) {
    const { q, confident } = parseBlock(b);
    if (q && confident) questions.push(q);
    else if (q) {
      // 低置信度题目仍保留(确认页可修),同时段落也进 leftovers 供 AI 重解
      leftovers.push(b.lines.join("\n"));
      questions.push(q);
    } else {
      leftovers.push(b.lines.join("\n"));
    }
  }
  // 完全没切出题时,整篇文本作为 leftover 交给 AI
  if (questions.length === 0 && preamble.length) {
    leftovers.push(preamble.join("\n"));
  }
  return { questions, leftovers: leftovers.filter((s) => s.trim().length > 10) };
}

/** 把 leftover 段落聚合成 ≤maxChars 的块(约等于 DeepSeek 3000 tokens) */
export function chunkTexts(texts: string[], maxChars = 2800): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const t of texts) {
    const piece = t.slice(0, maxChars);
    if (cur.length + piece.length > maxChars && cur) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + piece;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}
