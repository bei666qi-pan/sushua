import {
  FEATURE_FLAG_NAMES,
  getFeatureFlags,
  isFeatureEnabled,
  type FeatureFlagName,
} from "../src/lib/feature-flags";

let failed = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }

  failed += 1;
  console.error(`  ✗ ${name} ${detail}`);
}

const expectedFlags = [
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
] satisfies FeatureFlagName[];

console.log("Feature Flag 注册表");
assert(
  "覆盖实施计划中的全部 Flag",
  JSON.stringify(FEATURE_FLAG_NAMES) === JSON.stringify(expectedFlags),
  `got ${JSON.stringify(FEATURE_FLAG_NAMES)}`,
);

console.log("Feature Flag 默认值");
{
  const flags = getFeatureFlags({});
  assert("所有 Flag 默认关闭", Object.values(flags).every((value) => value === false));
}

console.log("Feature Flag 环境变量解析");
{
  const flags = getFeatureFlags({
    FEATURE_WORKSPACE_V1: "true",
    FEATURE_GUEST_CLAIM: "1",
    FEATURE_SOURCE_REVIEW: "on",
    FEATURE_FSRS_V1: "yes",
    FEATURE_PRESENTATIONS_P1: "TRUE",
    FEATURE_PAPER2ANY_EXPERIMENT: "enabled",
  });

  assert("明确真值可开启", flags.workspace_v1 && flags.guest_claim && flags.source_review && flags.fsrs_v1);
  assert("真值大小写不敏感", flags.presentations_p1);
  assert("未知值失败关闭", flags.paper2any_experiment === false);
}

console.log("Feature Flag 单项读取");
assert(
  "单项读取与注册表使用同一解析规则",
  isFeatureEnabled("workspace_v1", { FEATURE_WORKSPACE_V1: "true" }),
);
assert(
  "未配置单项保持关闭",
  !isFeatureEnabled("grounded_generation", {}),
);

if (failed > 0) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}

console.log("\n全部通过 ✓");
