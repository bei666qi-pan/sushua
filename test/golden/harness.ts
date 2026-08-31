export const GOLDEN_SCHEMA_VERSION = "sushua.golden-corpus.v1" as const;

export const GOLDEN_SOURCE_TYPES = [
  "native_pdf",
  "scanned_pdf",
  "photo",
  "docx",
  "pptx",
  "xlsx",
  "txt",
  "markdown",
  "html",
] as const;

export type GoldenSourceType = (typeof GOLDEN_SOURCE_TYPES)[number];

export type GoldenSample = {
  id: string;
  source_type: GoldenSourceType;
  fixture_path: string;
  sha256: string;
  license_spdx: string;
  provenance: string;
  expected_ir_path: string;
  expected_questions_path: string;
};

export type GoldenManifest = {
  schema_version: typeof GOLDEN_SCHEMA_VERSION;
  corpus_version: string;
  updated_at: string;
  samples: GoldenSample[];
};

export type GoldenManifestValidation =
  | { ok: true; value: GoldenManifest; errors: [] }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSample(value: unknown, index: number, errors: string[]): value is GoldenSample {
  if (!isRecord(value)) {
    errors.push(`samples[${index}] 必须是对象`);
    return false;
  }

  const requiredStrings = [
    "id",
    "fixture_path",
    "license_spdx",
    "provenance",
    "expected_ir_path",
    "expected_questions_path",
  ] as const;

  for (const field of requiredStrings) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`samples[${index}].${field} 必须是非空字符串`);
    }
  }

  if (!GOLDEN_SOURCE_TYPES.includes(value.source_type as GoldenSourceType)) {
    errors.push(`samples[${index}].source_type 不受支持`);
  }

  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    errors.push(`samples[${index}].sha256 必须是 64 位小写十六进制`);
  }

  return errors.length === 0;
}

export function validateGoldenManifest(value: unknown): GoldenManifestValidation {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { ok: false, errors: ["manifest 必须是对象"] };
  }

  if (value.schema_version !== GOLDEN_SCHEMA_VERSION) {
    errors.push(`schema_version 必须是 ${GOLDEN_SCHEMA_VERSION}`);
  }
  if (typeof value.corpus_version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.corpus_version)) {
    errors.push("corpus_version 必须是语义化版本");
  }
  if (typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at))) {
    errors.push("updated_at 必须是 ISO 日期时间");
  }
  if (!Array.isArray(value.samples)) {
    errors.push("samples 必须是数组");
  } else {
    const ids = new Set<string>();
    value.samples.forEach((sample, index) => {
      const before = errors.length;
      if (validateSample(sample, index, errors) && errors.length === before) {
        if (ids.has(sample.id)) errors.push(`samples[${index}].id 重复: ${sample.id}`);
        ids.add(sample.id);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: value as GoldenManifest, errors: [] };
}
