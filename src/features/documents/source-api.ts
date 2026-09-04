import { v7 as uuidv7 } from "uuid";
import type { CurrentIdentity } from "@/features/auth/current-identity";
import {
  createDocumentSourceModule,
  isDocumentBlockType,
  type DocumentBlockType,
  type SourceBlock,
  type SourcePage,
} from "./document-source-module";
import { createBlockSourceModule, type BlockSourceLocation } from "./block-source-module";

type SourceModule = ReturnType<typeof createDocumentSourceModule>;
type BlockSourceModule = ReturnType<typeof createBlockSourceModule>;
type IdentityResolver = { resolve(request: Request): Promise<CurrentIdentity> };

export function createDocumentSourceHandlers(input: {
    enabled: boolean;
    identity?: IdentityResolver;
    sources?: SourceModule;
    source?: BlockSourceModule;
  }) {
  return {
    LIST_PAGES: (request: Request, documentVersionId: string) => listPages(input, request, documentVersionId),
    LIST_BLOCKS: (request: Request, pageId: string) => listBlocks(input, request, pageId),
    GET_BLOCK_SOURCE: (request: Request, blockId: string) => getBlockSource(input, request, blockId),
  };
}

async function listPages(input: Parameters<typeof createDocumentSourceHandlers>[0], request: Request, documentVersionId: string): Promise<Response> {
  if (!input.enabled) return apiError(404, "not_found", "Not found", false);
  const parsed = parsePageQuery(request.url);
  if ("error" in parsed) return apiError(400, parsed.error, parsed.message, false);
  const { identity, sources } = dependencies(input);
  const current = await identity.resolve(request);
  try {
    const result = await sources.listPages(identityContext(current), { documentVersionId, ...parsed.input });
    return withIdentityCookie(Response.json({
      data: { document_version_id: documentVersionId, items: result.items.map(pageData) },
      meta: { request_id: uuidv7(), schema_version: "sushua.api.v1", ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}) },
    }), current);
  } catch (error) {
    return withIdentityCookie(sourceError(error), current);
  }
}

async function listBlocks(input: Parameters<typeof createDocumentSourceHandlers>[0], request: Request, pageId: string): Promise<Response> {
  if (!input.enabled) return apiError(404, "not_found", "Not found", false);
  const parsed = parseBlockQuery(request.url);
  if ("error" in parsed) return apiError(400, parsed.error, parsed.message, false);
  const { identity, sources } = dependencies(input);
  const current = await identity.resolve(request);
  try {
    const result = await sources.listBlocks(identityContext(current), { pageId, ...parsed.input });
    return withIdentityCookie(Response.json({
      data: { page_id: pageId, items: result.items.map(blockData) },
      meta: { request_id: uuidv7(), schema_version: "sushua.api.v1", ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}) },
    }), current);
  } catch (error) {
    return withIdentityCookie(sourceError(error), current);
  }
}

async function getBlockSource(input: Parameters<typeof createDocumentSourceHandlers>[0], request: Request, blockId: string): Promise<Response> {
  if (!input.enabled) return apiError(404, "not_found", "Not found", false);
  const { identity, source } = blockSourceDependencies(input);
  const current = await identity.resolve(request);
  try {
    const result = await source.getSource(identityContext(current), blockId);
    return withIdentityCookie(Response.json({
      data: blockSourceData(result),
      meta: { request_id: uuidv7(), schema_version: "sushua.api.v1" },
    }), current);
  } catch (error) {
    return withIdentityCookie(sourceError(error), current);
  }
}

function dependencies(input: Parameters<typeof createDocumentSourceHandlers>[0]) {
  if (!input.identity || !input.sources) throw new Error("document_source_api_dependencies_unavailable");
  return { identity: input.identity, sources: input.sources };
}

function blockSourceDependencies(input: Parameters<typeof createDocumentSourceHandlers>[0]) {
  if (!input.identity || !input.source) throw new Error("block_source_api_dependencies_unavailable");
  return { identity: input.identity, source: input.source };
}

function parsePageQuery(url: string, extraKeys: string[] = []): { input: { limit?: number; cursor?: string } } | ApiParseError {
  const search = new URL(url).searchParams;
  if (![...search.keys()].every((key) => key === "limit" || key === "cursor" || extraKeys.includes(key))
    || search.getAll("limit").length > 1 || search.getAll("cursor").length > 1) {
    return { error: "invalid_query", message: "查询参数无效" };
  }
  const limit = parseLimit(search.get("limit"));
  if (limit === null) return { error: "invalid_source_limit", message: "分页大小无效" };
  const cursor = search.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > 1024)) return { error: "invalid_source_cursor", message: "游标无效" };
  return { input: { ...(limit === undefined ? {} : { limit }), ...(cursor === null ? {} : { cursor }) } };
}

function parseBlockQuery(url: string): { input: { limit?: number; cursor?: string; blockTypes?: DocumentBlockType[]; minConfidence?: number } } | ApiParseError {
  const page = parsePageQuery(url, ["type", "min_confidence"]);
  if ("error" in page) return page;
  const search = new URL(url).searchParams;
  if (![...search.keys()].every((key) => key === "limit" || key === "cursor" || key === "type" || key === "min_confidence")
    || search.getAll("min_confidence").length > 1) {
    return { error: "invalid_query", message: "查询参数无效" };
  }
  const types: DocumentBlockType[] = [];
  for (const rawType of new Set(search.getAll("type"))) {
    if (!isDocumentBlockType(rawType)) return { error: "invalid_block_type", message: "Block 类型无效" };
    types.push(rawType);
  }
  const rawConfidence = search.get("min_confidence");
  let minConfidence: number | undefined;
  if (rawConfidence !== null) {
    if (!rawConfidence.trim()) return { error: "invalid_min_confidence", message: "最小置信度无效" };
    const parsedConfidence = Number(rawConfidence);
    if (!Number.isFinite(parsedConfidence) || parsedConfidence < 0 || parsedConfidence > 1) {
      return { error: "invalid_min_confidence", message: "最小置信度无效" };
    }
    minConfidence = parsedConfidence;
  }
  return { input: { ...page.input, ...(types.length ? { blockTypes: types } : {}), ...(minConfidence === undefined ? {} : { minConfidence }) } };
}

function parseLimit(raw: string | null): number | undefined | null {
  if (raw === null) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= 100 ? value : null;
}

function identityContext(identity: CurrentIdentity) {
  return { learnerId: identity.learnerId, ...(identity.kind === "user" ? { userId: identity.userId } : {}) };
}

function pageData(page: SourcePage) {
  return {
    id: page.id,
    document_version_id: page.documentVersionId,
    page_number: page.pageNumber,
    width: page.width,
    height: page.height,
    ...(page.renderedImageKey ? { rendered_image_key: page.renderedImageKey } : {}),
  };
}

function blockData(block: SourceBlock) {
  return {
    id: block.id,
    page_id: block.pageId,
    document_version_id: block.documentVersionId,
    ...(block.parentBlockId ? { parent_block_id: block.parentBlockId } : {}),
    block_type: block.blockType,
    ...(block.text === undefined ? {} : { text: block.text }),
    ...(block.markdown === undefined ? {} : { markdown: block.markdown }),
    bbox: block.bbox,
    reading_order: block.readingOrder,
    confidence: block.confidence,
    ...(block.headingLevel === undefined ? {} : { heading_level: block.headingLevel }),
    ...(block.tableStructure === undefined ? {} : { table_structure: block.tableStructure }),
    ...(block.formulaLatex === undefined ? {} : { formula_latex: block.formulaLatex }),
    ...(block.imageObjectKey === undefined ? {} : { image_object_key: block.imageObjectKey }),
    source_hash: block.sourceHash,
  };
}

function blockSourceData(source: BlockSourceLocation) {
  return {
    block: {
      id: source.block.id,
      block_type: source.block.blockType,
      bbox: source.block.bbox,
      confidence: source.block.confidence,
      source_hash: source.block.sourceHash,
    },
    page: {
      id: source.page.id,
      document_version_id: source.page.documentVersionId,
      page_number: source.page.pageNumber,
      width: source.page.width,
      height: source.page.height,
    },
    document_version: {
      id: source.documentVersion.id,
      document_id: source.documentVersion.documentId,
    },
    source_quote: source.sourceQuote,
    source_url: source.sourceUrl,
    source_url_expires_in_seconds: source.sourceUrlExpiresInSeconds,
  };
}

type ApiParseError = { error: string; message: string };

function sourceError(error: unknown) {
  const code = error instanceof Error ? error.message : "source_read_failed";
  if (["document_version_not_found", "page_not_found", "block_not_found"].includes(code)) return apiError(404, code, "Source not found", false);
  if (["invalid_document_version_id", "invalid_page_id", "invalid_block_id", "invalid_source_cursor", "invalid_source_limit", "invalid_block_type", "invalid_min_confidence"].includes(code)) {
    return apiError(400, code, "来源读取参数无效", false);
  }
  if (code === "source_asset_unavailable") return apiError(503, "source_unavailable", "来源原件暂时不可用", true);
  return apiError(503, "source_read_failed", "来源读取暂时不可用", true);
}

function withIdentityCookie(response: Response, identity: CurrentIdentity) {
  if (identity.kind === "guest") response.headers.append("set-cookie", identity.setCookie);
  return response;
}

function apiError(status: number, code: string, message: string, retryable: boolean) {
  return Response.json({ error: { code, message, retryable }, request_id: uuidv7() }, { status });
}
