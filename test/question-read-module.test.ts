import assert from "node:assert/strict";

async function main() {
  const questionModule = await import("../src/features/questions/question-read-module").catch(() => null);
  assert.ok(questionModule, "Question read module must exist");
  assert.equal(typeof questionModule.createQuestionReadModule, "function");
  const api = await import("../src/features/questions/question-read-api").catch(() => null);
  assert.ok(api, "Question read HTTP handler must exist");
  assert.equal(typeof api.createQuestionReadHandlers, "function");
  const route = await import("../src/app/api/v1/workspaces/[id]/questions/route").catch(() => null);
  assert.ok(route, "Workspace question route must exist");
  console.log("Question read module\n  ✓ Question read seam is available");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
