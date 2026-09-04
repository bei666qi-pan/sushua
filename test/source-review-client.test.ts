import assert from "node:assert/strict";
import test from "node:test";
import { createSourceReviewClient, SourceReviewApiError } from "@/features/documents/source-review-client";

const DOCUMENT_VERSION_ID = "018f5c32-967a-7d31-8a46-604ffb6d735d";
const PAGE_ID = "018f5c32-967b-7d31-8a46-604ffb6d735d";
const BLOCK_ID = "018f5c32-967c-7d31-8a46-604ffb6d735d";

test("source review client requests the first page of an allowed document version", async () => {
  const requests: Request[] = [];
  const client = createSourceReviewClient(async (input, init) => {
    requests.push(new Request(new URL(String(input), "http://localhost"), init));
    return Response.json({
      data: {
        document_version_id: DOCUMENT_VERSION_ID,
        items: [{ id: PAGE_ID, document_version_id: DOCUMENT_VERSION_ID, page_number: 3, width: 1000, height: 1400 }],
      },
      meta: { request_id: "request-1", schema_version: "sushua.api.v1" },
    });
  });

  const result = await client.listPages(DOCUMENT_VERSION_ID);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `http://localhost/api/v1/document-versions/${DOCUMENT_VERSION_ID}/pages?limit=100`);
  assert.equal(result.items[0].pageNumber, 3);
  assert.equal(result.items[0].width, 1000);
});

test("source review client sends low-confidence and block-type filters when loading a page", async () => {
  const requests: Request[] = [];
  const client = createSourceReviewClient(async (input, init) => {
    requests.push(new Request(new URL(String(input), "http://localhost"), init));
    return Response.json({
      data: {
        page_id: PAGE_ID,
        items: [{
          id: BLOCK_ID,
          page_id: PAGE_ID,
          document_version_id: DOCUMENT_VERSION_ID,
          block_type: "paragraph",
          text: "牛顿第二定律",
          bbox: [0.1, 0.2, 0.3, 0.1],
          reading_order: 1,
          confidence: 0.61,
          source_hash: "hash-1",
        }],
      },
      meta: { request_id: "request-2", schema_version: "sushua.api.v1" },
    });
  });

  const result = await client.listBlocks(PAGE_ID, { minConfidence: 0.6, blockTypes: ["paragraph", "formula"] });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `http://localhost/api/v1/pages/${PAGE_ID}/blocks?limit=100&type=paragraph&type=formula&min_confidence=0.6`,
  );
  assert.deepEqual(result.items[0].bbox, [0.1, 0.2, 0.3, 0.1]);
  assert.equal(result.items[0].text, "牛顿第二定律");
});

test("source review client exposes a retryable source error instead of treating it as an empty page", async () => {
  const client = createSourceReviewClient(async () => Response.json({
    error: { code: "source_unavailable", message: "来源原件暂时不可用", retryable: true },
    request_id: "request-3",
  }, { status: 503 }));

  await assert.rejects(
    () => client.getBlockSource(BLOCK_ID),
    (error: unknown) => error instanceof SourceReviewApiError
      && error.code === "source_unavailable"
      && error.retryable === true
      && error.message === "来源原件暂时不可用",
  );
});
