export type QType = "single" | "multiple" | "judge" | "fill" | "short";

export interface DraftQuestion {
  type: QType;
  stem: string;
  options: string[];
  /** single: "A"; multiple: "ABD"; judge: "对"/"错"; fill/short: 文本答案 */
  answer: string;
  explanation?: string;
}

export interface Question extends DraftQuestion {
  id: number;
  sort: number;
}

export type Visibility = "private" | "unlisted" | "public";

export interface Bank {
  id: number;
  slug: string;
  title: string;
  visibility: Visibility;
  created_at: string;
  question_count?: number;
}

export const TYPE_LABEL: Record<QType, string> = {
  single: "单选",
  multiple: "多选",
  judge: "判断",
  fill: "填空",
  short: "简答",
};
