/**
 * 产品能力开关的唯一注册表。
 *
 * 所有新能力默认关闭；只有明确的真值才会开启，以便旧路径保持不变并支持逐步灰度。
 */
export const FEATURE_FLAG_NAMES = [
  "workspace_v1",
  "postgres_shadow_write",
  "guest_claim",
  "workspace_library",
  "async_ingestion",
  "document_service",
  "ocr_pipeline",
  "document_ir_v1",
  "source_review",
  "grounded_generation",
  "grounded_explanations",
  "constraint_papers",
  "server_attempts",
  "wrong_questions_v2",
  "mastery_v1",
  "variants_v1",
  "flashcards_v1",
  "fsrs_v1",
  "analytics_v1",
  "workspace_export",
  "share_copy",
  "pdf_export_p1",
  "anki_export_p1",
  "presentations_p1",
  "paper2any_experiment",
  "knowledge_graph_p1",
] as const;

export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];
export type FeatureFlags = Readonly<Record<FeatureFlagName, boolean>>;
export type FeatureFlagEnvironment = Readonly<Record<string, string | undefined>>;

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function environmentKey(name: FeatureFlagName): string {
  return `FEATURE_${name.toUpperCase()}`;
}

function parseEnabled(value: string | undefined): boolean {
  return value === undefined ? false : ENABLED_VALUES.has(value.trim().toLowerCase());
}

export function isFeatureEnabled(
  name: FeatureFlagName,
  environment: FeatureFlagEnvironment = process.env,
): boolean {
  return parseEnabled(environment[environmentKey(name)]);
}

export function getFeatureFlags(
  environment: FeatureFlagEnvironment = process.env,
): FeatureFlags {
  return Object.freeze(
    Object.fromEntries(
      FEATURE_FLAG_NAMES.map((name) => [name, isFeatureEnabled(name, environment)]),
    ) as Record<FeatureFlagName, boolean>,
  );
}
