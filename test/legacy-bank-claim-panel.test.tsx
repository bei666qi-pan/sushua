import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function main() {
  const panelModule = await import("../src/components/legacy-bank-claim-panel").catch(() => null);
  assert.ok(panelModule, "legacy bank claim panel must exist");
  assert.equal(typeof panelModule.LegacyBankClaimPanel, "function");

  const standard = renderToStaticMarkup(
    <panelModule.LegacyBankClaimPanel slug="legacy-bank" pendingAfterLogin={false} />,
  );
  assert.match(standard, />认领到账号</);
  assert.match(standard, /不会把凭证放进网址/);
  assert.match(standard, /当前题目仍由旧题库读取/);
  console.log("旧题库认领面板\n  ✓ 默认状态提供清晰动作与凭证/迁移边界说明");

  const returning = renderToStaticMarkup(
    <panelModule.LegacyBankClaimPanel slug="legacy-bank" pendingAfterLogin />,
  );
  assert.match(returning, /登录完成，继续认领旧题库/);
  assert.match(returning, />完成认领</);
  console.log("  ✓ 登录回流后依然需要用户显式完成认领");
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
