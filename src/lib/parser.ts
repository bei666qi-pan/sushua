import type { DraftQuestion, QType } from "./types";

/**
 * 规则切题管线:纯正则,零 AI 成本。
 * 识别:题号、选项 A-F、答案(字母/对错/文本)、解析、章节题型提示。
 * 规则解析不出或可疑的段落进入 leftovers,由上层决定是否调 AI 兜底。
 * 设计原则:宁可降置信度走 AI 兜底,绝不静默丢题。
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

// ---------- 行级正则 ----------

/** 题号:1. / 1、 / 1) / (1) / 第1题,裸数字形式必须带分隔符(防误伤"2026年…") */
const Q_START = /^\s*(?:第\s*(\d{1,3})\s*题\s*[..、、).::]?|[(]\s*(\d{1,3})\s*[)]\s*[..、、.::]?|(\d{1,3})\s*[..、、).::])\s*/;
const OPTION_RE = /^\s*\(?([A-F])[))..、、::]\s*(.+?)\s*$/;
/** 答案行:答案/参考答案/正确答案/标准答案/【答案】/答:(裸"答"必须带冒号) */
const ANSWER_RE = /^[\s ]*(?:【\s*(?:参考|正确|标准)?答案\s*】|(?:参考|正确|标准)?答案|答(?=\s*[::]))\s*[::]?\s*(.*)$/;
const EXPLAIN_RE = /^[\s ]*(?:【\s*解析\s*】|解析|【\s*注释\s*】)\s*[::]?\s*(.*)$/;
/** 题干行内 "( 答案:B )" 形式(normalize 阶段改写成标准答案行) */
const PAREN_LABELED_ANSWER = /[((]\s*答案\s*[::]?\s*([A-F]{1,6}|对|错|√|×|正确|错误|T|F)\s*[))]/g;
/** 题干括号内嵌答案:"同(C)相结合"、"(ABD)"、"( √ )"。只认大写字母,防止"如图(a)"图标号误判 */
const PAREN_ANSWER = /[((]\s*([A-F](?:[\s,,、]*[A-F]){0,5}|对|错|√|×|正确|错误)\s*[))]/g;
/** 答案 token(字母/判断类) */
const ANS_TOKEN = "(?:[A-F]{1,6}|对|错|√|×|正确|错误)";

// ---------- normalize:把各种粘连排版整理成规整的行 ----------

/**
 * 行内粘连选项拆行:"题干A.xxB.yyC.zzD.ww" → 题干与各选项独立成行。
 * 只有当行内出现字母严格连续递增(A→B→C…)的 ≥2 个选项标记,
 * 且每个选项段都有实际内容时才拆,避免误拆 "USB." "A.B.C.D.类地址" 等普通文本。
 */
function splitInlineOptions(line: string): string[] {
  const re = /([A-F])\s*[..、]/g;
  const marks: Array<{ letter: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) marks.push({ letter: m[1], index: m.index });
  if (marks.length < 2) return [line];

  const startIdx = Math.max(0, marks.findIndex((k) => k.letter === "A"));
  const chain: Array<{ letter: string; index: number }> = [];
  let expected = marks[startIdx].letter.charCodeAt(0);
  for (let i = startIdx; i < marks.length; i++) {
    if (marks[i].letter.charCodeAt(0) === expected) {
      chain.push(marks[i]);
      expected++;
    }
  }
  if (chain.length < 2) return [line];

  const segments = chain.map((c, i) =>
    line.slice(c.index, i + 1 < chain.length ? chain[i + 1].index : undefined)
  );
  if (!segments.every((s) => s.replace(/^[A-F]\s*[..、]/, "").trim())) return [line];

  const head = line.slice(0, chain[0].index).trim();
  return head ? [head, ...segments] : segments;
}

function normalize(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n");
  s = s.replace(/[ＡＢＣＤＥＦ０-９．：（）　]/g, (c) => FULL_TO_HALF[c] ?? c);
  return s
    .split("\n")
    .flatMap((line) => {
      let l = line
        // "( 答案:B )" 行内标注 → 挖空 + 标准答案行,防止后续断行把它劈坏
        .replace(PAREN_LABELED_ANSWER, "(    )\n答案:$1")
        // 粘连的 "答案:" / "解析:" 前断行(不在括号后断;"回答:/解答:"等词不断)
        .replace(/(?<=[^\s((])(?=【?\s*(?:参考|正确|标准)?答案\s*[::])/g, "\n")
        .replace(/(?<=[^\s((回解作问应对])(?=答\s*[::])/g, "\n")
        .replace(/(?<=[^\s((])(?=【?\s*解析\s*[::])/g, "\n");
      // 答案值与下一题号粘连:"答案:C2.下一题…" / "答案:B。 2、…" → 在答案值后断行
      l = l.replace(
        new RegExp(
          `((?:【\\s*(?:参考|正确|标准)?答案\\s*】|(?:参考|正确|标准)?答案|答)\\s*[::]?\\s*${ANS_TOKEN})\\s*[。..]?\\s*(?=(?:第\\s*\\d{1,3}\\s*题|[(]\\s*\\d{1,3}\\s*[)]|\\d{1,3}\\s*[..、、)])\\S)`,
          "g"
        ),
        "$1\n"
      );
      return l.split("\n").flatMap(splitInlineOptions);
    })
    .join("\n");
}

// ---------- 章节标题(题型提示) ----------

/**
 * 只把「标题形态」的行当章节标题:去掉编号后必须以题型关键词起头,
 * 且其后只允许"题"字与分数/数量说明。
 * "一、单选题"“三、简答题(每题5分)"→ 标题;
 * "3.判断链表是否有环…"“1.试论述…"“2、名词解释:机会成本"→ 普通题目,绝不吞。
 */
function sectionHint(line: string): QType | null {
  let t = line.trim();
  if (!t || t.length > 40) return null;
  t = t.replace(/^[一二三四五六七八九十0-9]+\s*[、..::]\s*/, "").replace(/^【\s*|\s*】$/g, "").trim();
  const m = t.match(/^(单项选择|多项选择|不定项选择|单选|多选|不定项|判断|填空|简答|问答|论述|名词解释|选择)\s*(题)?/);
  if (!m) return null;
  const rest = t.slice(m[0].length).trim();
  // 剩余内容只能为空、或括号包起来的说明、或 ":共N题/(每题2分)"式说明
  const restOk =
    rest === "" ||
    /^[((〔\[].{0,30}[))〕\]]?\s*[::]?$/.test(rest) ||
    /^[::]\s*(?:[((〔\[].{0,30}|共.{0,20})?$/.test(rest);
  if (!restOk) return null;
  const k = m[1];
  if (/多项|多选|不定项/.test(k)) return "multiple";
  if (/单项|单选|选择/.test(k)) return "single";
  if (k === "判断") return "judge";
  if (k === "填空") return "fill";
  return "short"; // 简答 | 问答 | 论述 | 名词解释
}

// ---------- 答案 token 解析 ----------

function parseAnswerToken(s: string, hasOptions: boolean): { value: string; kind: "letters" | "judge" | "text" } | null {
  let raw = s.trim();
  raw = raw.replace(/^[是为::\s]+/, ""); // "答案是B" / "答案为对"
  raw = raw.replace(/[\s。..;;,,!!))】]+$/g, ""); // 去尾部标点:"B。" "ABD。"
  const t = raw.replace(/[\s,,、。]/g, "").toUpperCase();
  if (!t) return null;
  // 无选项时单个 F/T 是判断题答案,不是选项字母
  if (!hasOptions && /^(F|FALSE|N|NO)$/.test(t)) return { value: "错", kind: "judge" };
  if (!hasOptions && /^(T|TRUE|Y|YES)$/.test(t)) return { value: "对", kind: "judge" };
  if (/^[A-F]{1,6}$/.test(t)) return { value: [...new Set(t.split(""))].sort().join(""), kind: "letters" };
  if (/^(对|√|正确|T|TRUE|YES)$/.test(t)) return { value: "对", kind: "judge" };
  if (/^(错|×|X|错误|F|FALSE|NO)$/.test(t)) return { value: "错", kind: "judge" };
  if (!hasOptions) return { value: raw, kind: "text" };
  return null;
}

// ---------- 分块 ----------

interface Block { hint: QType | null; lines: string[] }

function looksLikeQuestion(rest: string): boolean {
  const t = rest.trim();
  if (t.length < 6) return false;
  return (
    t.length >= 20 ||
    /[??]|\(\s*\)|_{2,}|【\s*】|下列|以下|关于|哪|什么|如何|为什么|简述|论述|试述|名词解释|属于|不属于|正确的是|错误的是/.test(t)
  );
}

function splitBlocks(text: string): { blocks: Block[]; preamble: string[] } {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const preamble: string[] = [];
  let cur: Block | null = null;
  let hint: QType | null = null;
  let lastNum: number | null = null;
  let sectionReset = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = sectionHint(line);
    if (h) {
      hint = h;
      sectionReset = true;
      continue;
    }
    const m = line.match(Q_START);
    if (m) {
      const num = Number(m[1] ?? m[2] ?? m[3]);
      const rest = line.replace(Q_START, "");
      // 下一非空行是答案/选项行 → 这一定是题干,不是答案要点
      let ni = i + 1;
      while (ni < lines.length && !lines[ni].trim()) ni++;
      const next = lines[ni] ?? "";
      const nextIsStructure = ANSWER_RE.test(next) || OPTION_RE.test(next);
      // 当前块已进入答案/解析区后,编号行更可能是"答案要点 1. 2. 3.":
      // 需要编号连续且有题干特征才开新块;常规区则宽松(连续 或 像题干)
      const inAnswerZone = cur !== null && cur.lines.some((l) => ANSWER_RE.test(l) || EXPLAIN_RE.test(l));
      const seqOk =
        lastNum === null || num === lastNum + 1 || (sectionReset && num <= 1) || /^\s*第\s*\d/.test(line);
      const accept =
        cur === null ||
        sectionReset || // 刚遇到章节标题,紧随的编号行必是新题
        (inAnswerZone
          ? seqOk && (looksLikeQuestion(rest) || nextIsStructure)
          : seqOk || looksLikeQuestion(rest) || nextIsStructure);
      if (accept) {
        if (cur) blocks.push(cur);
        cur = { hint, lines: [rest] };
        lastNum = Number.isFinite(num) ? num : lastNum;
        sectionReset = false;
        continue;
      }
    }
    if (cur) cur.lines.push(line);
    else if (line.trim()) preamble.push(line);
  }
  if (cur) blocks.push(cur);
  return { blocks, preamble };
}

// ---------- 单块解析 ----------

function parseBlock(block: Block): { q: DraftQuestion | null; confident: boolean } {
  const stemLines: string[] = [];
  const options: string[] = [];
  const optionLetters: string[] = [];
  let answerRaw: string | null = null;
  let explanation = "";
  let suspicious = false; // 块内出现了"不该出现"的结构(第二个答案行/解析区里冒出选项),疑似吞了下一题
  let mode: "stem" | "options" | "answer" | "explain" = "stem";

  for (const line of block.lines) {
    if (!line.trim()) continue;
    const ans = line.match(ANSWER_RE);
    const exp = line.match(EXPLAIN_RE);
    const opt = line.match(OPTION_RE);
    if (exp) {
      if (explanation) suspicious = true;
      explanation = explanation ? explanation + "\n" + exp[1] : exp[1];
      mode = "explain";
    } else if (ans && answerRaw === null) {
      answerRaw = ans[1];
      mode = "answer";
    } else if (ans && answerRaw !== null) {
      suspicious = true; // 一个块里第二个答案行:大概率吞了下一题
      mode = "answer";
    } else if (opt && mode !== "explain") {
      options.push(opt[2]);
      optionLetters.push(opt[1]);
      mode = "options";
    } else if (opt && mode === "explain") {
      suspicious = true; // 解析区里出现选项行:大概率吞了下一题
      explanation += "\n" + line.trim();
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
  // 过短的"题干"(如文末答案表被切出的 "A")不是题,整块退给 AI
  if (!stem || stem.replace(/[\s..、、::()()]/g, "").length <= 2) return { q: null, confident: false };

  // 题干括号内嵌答案:"同(C)相结合" / "(ABD)" / "(√)",提取后回填空位
  let parenExtracted = false;
  const parenMatches = [...stem.matchAll(PAREN_ANSWER)];
  if (answerRaw === null && parenMatches.length === 1) {
    answerRaw = parenMatches[0][1];
    stem = stem.replace(parenMatches[0][0], "(    )").trim();
    parenExtracted = true;
  } else if (answerRaw !== null && parenMatches.length === 1) {
    // 答案行已给出,但题干里还留着 "(C)" 明文答案 → 挖空防剧透
    const inParen = parseAnswerToken(parenMatches[0][1], options.length > 0);
    const fromLine = parseAnswerToken(answerRaw, options.length > 0);
    if (inParen && fromLine && inParen.value === fromLine.value) {
      stem = stem.replace(parenMatches[0][0], "(    )").trim();
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
    type = parsed.value.length > 40 ? "short" : "fill";
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
      answer = parsed.kind === "text" ? parsed.value : answerRaw?.trim() ?? "";
    }
  }

  const q: DraftQuestion = { type, stem, options, answer, explanation: explanation.trim() || undefined };

  // 置信度:结构完整 + 答案匹配题型;不确定的进 AI 兜底,绝不静默吞
  let confident = !suspicious;
  if (type === "single" && answer.length > 1) confident = false;
  if (options.length === 1) confident = false;
  // 明明标注了答案却没解析出来(如 "答案:C2.下一题…" 粘连污染)→ AI 重解
  if (answerRaw !== null && answerRaw.trim() && !parsed) confident = false;
  // 答案字母超出实际选项范围(如 4 个选项答 F)
  if ((type === "single" || type === "multiple") && answer && optionLetters.length) {
    if (![...answer].every((c) => optionLetters.includes(c))) confident = false;
  }
  // 选项字母出现重复(A,B,C,D,A,B…):吞了下一题的选项
  if (new Set(optionLetters).size !== optionLetters.length) confident = false;
  // 括号里挖出了字母答案却没有任何选项 → 结构不完整
  if (parenExtracted && parsed?.kind === "letters" && options.length === 0) confident = false;
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
