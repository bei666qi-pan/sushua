export type SourceReviewPage = {
  id: string;
  documentVersionId: string;
  pageNumber: number;
  width: number;
  height: number;
  renderedImageKey?: string;
};

export type SourceReviewBlock = {
  id: string;
  pageId: string;
  documentVersionId: string;
  parentBlockId?: string;
  blockType: string;
  text?: string;
  markdown?: string;
  bbox: [number, number, number, number];
  readingOrder: number;
  confidence: number;
  sourceHash: string;
};

export type SourceReviewLocation = {
  block: Pick<SourceReviewBlock, "id" | "blockType" | "bbox" | "confidence" | "sourceHash">;
  page: Pick<SourceReviewPage, "id" | "documentVersionId" | "pageNumber" | "width" | "height">;
  documentVersion: { id: string; documentId: string };
  sourceQuote: string;
  sourceUrl: string;
  sourceUrlExpiresInSeconds: number;
};

export type SourceReviewBlockFilters = {
  minConfidence?: number;
  blockTypes?: string[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SourceReviewApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SourceReviewApiError";
  }
}

export function createSourceReviewClient(fetcher: FetchLike = fetch) {
  return {
    async listPages(documentVersionId: string): Promise<{ items: SourceReviewPage[]; nextCursor?: string }> {
      const payload = await getJson(`/api/v1/document-versions/${encodePath(documentVersionId)}/pages?limit=100`, fetcher);
      return {
        items: arrayOf(payload, "data.items").map(pageFromApi),
        ...(optionalString(recordAt(payload, "meta").next_cursor) ? { nextCursor: optionalString(recordAt(payload, "meta").next_cursor) } : {}),
      };
    },

    async listBlocks(pageId: string, filters: SourceReviewBlockFilters = {}): Promise<{ items: SourceReviewBlock[]; nextCursor?: string }> {
      const query = new URLSearchParams({ limit: "100" });
      for (const type of filters.blockTypes ?? []) query.append("type", type);
      if (filters.minConfidence !== undefined) query.set("min_confidence", String(filters.minConfidence));
      const payload = await getJson(`/api/v1/pages/${encodePath(pageId)}/blocks?${query.toString()}`, fetcher);
      return {
        items: arrayOf(payload, "data.items").map(blockFromApi),
        ...(optionalString(recordAt(payload, "meta").next_cursor) ? { nextCursor: optionalString(recordAt(payload, "meta").next_cursor) } : {}),
      };
    },

    async getBlockSource(blockId: string): Promise<SourceReviewLocation> {
      return locationFromApi(await getJson(`/api/v1/blocks/${encodePath(blockId)}/source`, fetcher));
    },
  };
}

async function getJson(path: string, fetcher: FetchLike): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(path, { headers: { accept: "application/json" } });
  } catch {
    throw new SourceReviewApiError("来源读取请求失败，请检查网络后重试", "source_review_network_error", true);
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = recordAt(body, "error");
    throw new SourceReviewApiError(
      optionalString(error.message) ?? "来源读取暂时不可用",
      optionalString(error.code) ?? "source_review_request_failed",
      error.retryable === true,
    );
  }
  if (!isRecord(body) || !isRecord(body.data)) {
    throw new SourceReviewApiError("来源返回格式无效，请稍后重试", "source_review_response_invalid", true);
  }
  return body;
}

function pageFromApi(value: unknown): SourceReviewPage {
  const item = requireRecord(value);
  return {
    id: requireString(item.id),
    documentVersionId: requireString(item.document_version_id),
    pageNumber: requireNumber(item.page_number),
    width: requireNumber(item.width),
    height: requireNumber(item.height),
    ...(optionalString(item.rendered_image_key) ? { renderedImageKey: optionalString(item.rendered_image_key) } : {}),
  };
}

function blockFromApi(value: unknown): SourceReviewBlock {
  const item = requireRecord(value);
  return {
    id: requireString(item.id),
    pageId: requireString(item.page_id),
    documentVersionId: requireString(item.document_version_id),
    ...(optionalString(item.parent_block_id) ? { parentBlockId: optionalString(item.parent_block_id) } : {}),
    blockType: requireString(item.block_type),
    ...(optionalString(item.text) ? { text: optionalString(item.text) } : {}),
    ...(optionalString(item.markdown) ? { markdown: optionalString(item.markdown) } : {}),
    bbox: bboxFromApi(item.bbox),
    readingOrder: requireNumber(item.reading_order),
    confidence: requireNumber(item.confidence),
    sourceHash: requireString(item.source_hash),
  };
}

function locationFromApi(payload: Record<string, unknown>): SourceReviewLocation {
  const data = requireRecord(payload.data);
  const block = requireRecord(data.block);
  const page = requireRecord(data.page);
  const version = requireRecord(data.document_version);
  return {
    block: {
      id: requireString(block.id),
      blockType: requireString(block.block_type),
      bbox: bboxFromApi(block.bbox),
      confidence: requireNumber(block.confidence),
      sourceHash: requireString(block.source_hash),
    },
    page: {
      id: requireString(page.id),
      documentVersionId: requireString(page.document_version_id),
      pageNumber: requireNumber(page.page_number),
      width: requireNumber(page.width),
      height: requireNumber(page.height),
    },
    documentVersion: { id: requireString(version.id), documentId: requireString(version.document_id) },
    sourceQuote: requireString(data.source_quote),
    sourceUrl: requireString(data.source_url),
    sourceUrlExpiresInSeconds: requireNumber(data.source_url_expires_in_seconds),
  };
}

function arrayOf(payload: Record<string, unknown>, path: string): unknown[] {
  const [first, second] = path.split(".");
  const value = first && second ? recordAt(payload, first)[second] : undefined;
  if (!Array.isArray(value)) throw new SourceReviewApiError("来源返回格式无效，请稍后重试", "source_review_response_invalid", true);
  return value;
}

function recordAt(value: unknown, key: string): Record<string, unknown> {
  return isRecord(value) && isRecord(value[key]) ? value[key] : {};
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new SourceReviewApiError("来源返回格式无效，请稍后重试", "source_review_response_invalid", true);
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new SourceReviewApiError("来源返回格式无效，请稍后重试", "source_review_response_invalid", true);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SourceReviewApiError("来源返回格式无效，请稍后重试", "source_review_response_invalid", true);
  }
  return value;
}

function bboxFromApi(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new SourceReviewApiError("来源返回格式无效，请稍后重试", "source_review_response_invalid", true);
  }
  return value as [number, number, number, number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}
