import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const DOCUMENT_VERSION_ID = "018f5c32-967a-7d31-8a46-604ffb6d735d";

async function main() {
  const panelModule = await import("../src/features/documents/source-review-panel").catch(() => null);
  assert.ok(panelModule, "source review panel must exist");
  assert.equal(typeof panelModule.SourceReviewPanel, "function");

  const markup = renderToStaticMarkup(<panelModule.SourceReviewPanel documentVersionId={DOCUMENT_VERSION_ID} />);

  assert.match(markup, /原文核对/);
  assert.match(markup, /返回资料库/);
  assert.match(markup, /href="\/workspaces"/);
  assert.match(markup, /正在读取资料页面/);
  assert.match(markup, /点击内容块后，会显示原件页码、引用和临时预览链接/);
  assert.match(markup, /aria-busy="true"/);

  assert.equal(typeof panelModule.MobileSourceDrawer, "function");
  const drawer = renderToStaticMarkup(
    <panelModule.MobileSourceDrawer
      open
      onClose={() => undefined}
      location={{
        block: { id: "018f5c32-967c-7d31-8a46-604ffb6d735d", blockType: "paragraph", bbox: [0.1, 0.2, 0.3, 0.1], confidence: 0.61, sourceHash: "hash-1" },
        page: { id: "018f5c32-967b-7d31-8a46-604ffb6d735d", documentVersionId: DOCUMENT_VERSION_ID, pageNumber: 3, width: 1000, height: 1400 },
        documentVersion: { id: DOCUMENT_VERSION_ID, documentId: "018f5c32-967d-7d31-8a46-604ffb6d735d" },
        sourceQuote: "牛顿第二定律",
        sourceUrl: "https://files.example.test/original.pdf?signature=short-lived",
        sourceUrlExpiresInSeconds: 300,
      }}
    />,
  );
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /原文第 3 页预览/);
  assert.match(drawer, /#page=3/);
  console.log("原文核对面板\n  ✓ 初始状态清楚告知读取进度与来源定位边界\n\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
