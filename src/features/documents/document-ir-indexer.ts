import { createHash } from "node:crypto";

import { v7 as uuidv7 } from "uuid";

import type { PostgresRuntime } from "@/db/postgres/runtime";
import type { SourceObjectReader } from "@/features/security/file-scan-handler";
import type { DocumentParseResult, DocumentParseTarget } from "./document-parse";

const IR_SCHEMA_VERSION = "sushua.document-ir.v1";
const MAX_IR_BYTES = 32 * 1024 * 1024;
const BLOCK_TYPES = new Set([
  "heading", "paragraph", "list", "list_item", "table", "table_cell", "formula", "image",
  "question_candidate", "answer_candidate", "text", "unknown",
]);

export type DocumentIrIndexingInput = {
  target: DocumentParseTarget;
  expectedAttempt: number;
  result: DocumentParseResult;
  signal: AbortSignal;
};

export type DocumentIrIndexingModule = {
  index(value: DocumentIrIndexingInput): Promise<{ pageCount: number; blockCount: number; replayed: boolean }>;
  close(): Promise<void>;
};

type IndexedDocumentIr = {
  pages: Array<{
    id: string;
    pageNumber: number;
    width: number;
    height: number;
    renderedImageKey?: string;
  }>;
  blocks: Array<{
    id: string;
    pageId: string;
    parentBlockId?: string;
    blockType: string;
    text?: string;
    markdown?: string;
    bbox: number[];
    readingOrder: number;
    confidence: number;
    headingLevel?: number;
    tableStructure?: Record<string, unknown> | unknown[];
    formulaLatex?: string;
    imageObjectKey?: string;
    sourceHash: string;
  }>;
};

export function createDocumentIrIndexingModule(
  runtime: PostgresRuntime,
  input: { reader: SourceObjectReader; now?: () => Date },
): DocumentIrIndexingModule {
  const now = input.now ?? (() => new Date());
  return {
    async index(value: DocumentIrIndexingInput): Promise<{ pageCount: number; blockCount: number; replayed: boolean }> {
      assertTarget(value.target, value.expectedAttempt, value.result);
      const bytes = await readAndHash(input.reader, value.result.irObjectKey, value.signal);
      if (bytes.sha256 !== value.result.irSha256) throw new Error("document_ir_hash_mismatch");
      const ir = parseIr(bytes.body, value.target, value.result);
      const indexedAt = now();
      if (!Number.isFinite(indexedAt.getTime())) throw new Error("invalid_document_ir_index_timestamp");
      return runtime.withTenant<{ pageCount: number; blockCount: number; replayed: boolean }>({ learnerId: value.target.jobId }, async ({ query }) => {
        const saved = await query<{ result: unknown }>(
          "SELECT index_document_ir_v1($1,$2,$3,$4,$5) AS result",
          [value.target.jobId, value.expectedAttempt, value.result.irSha256, ir, indexedAt],
        );
        return parseIndexResult(saved.rows[0]?.result);
      });
    },
    close: () => runtime.close(),
  };
}

async function readAndHash(reader: SourceObjectReader, key: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error("document_ir_read_aborted");
  const source = await reader.read({ key }, signal);
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    if (signal.aborted) throw new Error("document_ir_read_aborted");
    if (!(chunk instanceof Uint8Array)) throw new Error("invalid_document_ir_stream");
    size += chunk.byteLength;
    if (size > MAX_IR_BYTES) throw new Error("document_ir_too_large");
    hash.update(chunk);
    chunks.push(Buffer.from(chunk));
  }
  return { body: Buffer.concat(chunks), sha256: hash.digest("hex") };
}

function parseIr(bytes: Buffer, target: DocumentParseTarget, result: DocumentParseResult): IndexedDocumentIr {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid_document_ir_json");
  }
  const envelope = record(value, "invalid_document_ir");
  exactKeys(envelope, ["schemaVersion", "document"], "invalid_document_ir");
  if (envelope.schemaVersion !== IR_SCHEMA_VERSION) throw new Error("invalid_document_ir_schema");
  const document = record(envelope.document, "invalid_document_ir");
  requireKeys(document, ["id", "workspaceId", "documentVersionId", "source", "parseConfig", "parser", "pages"], "invalid_document_ir");
  rejectUnknownKeys(document, ["id", "workspaceId", "documentVersionId", "source", "parseConfig", "parser", "pages", "routing"], "invalid_document_ir");
  if (document.id !== target.documentId
    || document.workspaceId !== target.workspaceId
    || document.documentVersionId !== target.documentVersionId
    || !sameJson(document.parseConfig, target.parseConfig)) {
    throw new Error("document_ir_identity_mismatch");
  }
  const source = record(document.source, "invalid_document_ir");
  exactKeys(source, ["assetId", "objectKey", "sha256", "sizeBytes", "mimeType"], "invalid_document_ir");
  if (source.assetId !== target.sourceAssetId
    || source.objectKey !== target.sourceObjectKey
    || source.sha256 !== target.sourceSha256
    || source.sizeBytes !== target.sizeBytes
    || source.mimeType !== target.mimeType) {
    throw new Error("document_ir_source_mismatch");
  }
  const parser = record(document.parser, "invalid_document_ir");
  exactKeys(parser, ["name", "version"], "invalid_document_ir");
  if (parser.name !== result.parser || parser.version !== result.parserVersion) {
    throw new Error("document_ir_parser_mismatch");
  }
  if (!Array.isArray(document.pages) || document.pages.length !== result.pageCount) {
    throw new Error("document_ir_page_count_mismatch");
  }
  return indexPages(document.pages, target, result.parserVersion);
}

function indexPages(pages: unknown[], target: DocumentParseTarget, parserVersion: string): IndexedDocumentIr {
  const indexed: IndexedDocumentIr = { pages: [], blocks: [] };
  const blockIds = new Map<string, string>();
  const parentReferences: Array<{ persistedId: string; sourceId: string }> = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = record(pages[index], "invalid_document_ir_page");
    requireKeys(page, ["pageNumber", "width", "height", "blocks"], "invalid_document_ir_page");
    rejectUnknownKeys(page, ["pageNumber", "width", "height", "renderedImageKey", "blocks"], "invalid_document_ir_page");
    if (page.pageNumber !== index + 1 || !positiveNumber(page.width) || !positiveNumber(page.height) || !Array.isArray(page.blocks)) {
      throw new Error("invalid_document_ir_page");
    }
    const pageId = uuidv7();
    const renderedImageKey = optionalString(page.renderedImageKey, "invalid_document_ir_page");
    if (renderedImageKey && !tenantObjectKey(renderedImageKey, target.workspaceId)) throw new Error("invalid_document_ir_object_key");
    indexed.pages.push({ id: pageId, pageNumber: page.pageNumber, width: page.width, height: page.height, ...(renderedImageKey ? { renderedImageKey } : {}) });
    for (const rawBlock of page.blocks) {
      const parsed = indexBlock(rawBlock, pageId, target, parserVersion);
      if (blockIds.has(parsed.sourceId)) throw new Error("duplicate_document_ir_block_id");
      blockIds.set(parsed.sourceId, parsed.block.id);
      if (parsed.parentSourceId) parentReferences.push({ persistedId: parsed.block.id, sourceId: parsed.parentSourceId });
      indexed.blocks.push(parsed.block);
    }
  }
  for (const parent of parentReferences) {
    const block = indexed.blocks.find((candidate) => candidate.id === parent.persistedId);
    const parentBlockId = blockIds.get(parent.sourceId);
    if (!block || !parentBlockId || parentBlockId === block.id) throw new Error("invalid_document_ir_parent");
    block.parentBlockId = parentBlockId;
  }
  return indexed;
}

function indexBlock(raw: unknown, pageId: string, target: DocumentParseTarget, parserVersion: string) {
  const value = record(raw, "invalid_document_ir_block");
  requireKeys(value, ["blockId", "blockType", "bbox", "readingOrder", "confidence", "sourceHash"], "invalid_document_ir_block");
  rejectUnknownKeys(value, [
    "blockId", "parentBlockId", "blockType", "text", "markdown", "bbox", "readingOrder", "confidence", "headingLevel",
    "tableStructure", "formulaLatex", "imageObjectKey", "sourceHash",
  ], "invalid_document_ir_block");
  const blockId = value.blockId;
  const blockType = value.blockType;
  const readingOrder = value.readingOrder;
  const confidence = value.confidence;
  const sourceHash = value.sourceHash;
  if (typeof blockId !== "string" || !safeBlockId(blockId)
    || typeof blockType !== "string" || !BLOCK_TYPES.has(blockType)
    || typeof readingOrder !== "number" || !Number.isInteger(readingOrder) || readingOrder < 0
    || !finiteInRange(confidence, 0, 1)
    || typeof sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(sourceHash)) {
    throw new Error("invalid_document_ir_block");
  }
  const text = optionalString(value.text, "invalid_document_ir_block");
  const markdown = optionalString(value.markdown, "invalid_document_ir_block");
  const bbox = validBbox(value.bbox);
  if (!sourceHashCandidates(parserVersion, text ?? "", bbox, target.sourceSha256).has(sourceHash)) {
    throw new Error("document_ir_source_hash_mismatch");
  }
  const headingLevel = optionalInteger(value.headingLevel, "invalid_document_ir_block");
  if ((blockType === "heading" && (!headingLevel || headingLevel < 1 || headingLevel > 6))
    || (blockType !== "heading" && headingLevel !== undefined)) {
    throw new Error("invalid_document_ir_heading");
  }
  const parentSourceId = optionalString(value.parentBlockId, "invalid_document_ir_block");
  if (parentSourceId && !safeBlockId(parentSourceId)) throw new Error("invalid_document_ir_parent");
  const imageObjectKey = optionalString(value.imageObjectKey, "invalid_document_ir_block");
  if (imageObjectKey && !tenantObjectKey(imageObjectKey, target.workspaceId)) throw new Error("invalid_document_ir_object_key");
  const tableStructure = value.tableStructure === undefined ? undefined : jsonValue(value.tableStructure, "invalid_document_ir_block");
  const formulaLatex = optionalString(value.formulaLatex, "invalid_document_ir_block");
  return {
    sourceId: blockId,
    parentSourceId,
    block: {
      id: uuidv7(), pageId, blockType, bbox, readingOrder,
      confidence, sourceHash,
      ...(text === undefined ? {} : { text }),
      ...(markdown === undefined ? {} : { markdown }),
      ...(headingLevel === undefined ? {} : { headingLevel }),
      ...(tableStructure === undefined ? {} : { tableStructure }),
      ...(formulaLatex === undefined ? {} : { formulaLatex }),
      ...(imageObjectKey === undefined ? {} : { imageObjectKey }),
    },
  };
}

function assertTarget(target: DocumentParseTarget, expectedAttempt: number, result: DocumentParseResult) {
  if (target.parseStatus !== "parsing" || target.irSchemaVersion !== IR_SCHEMA_VERSION
    || !Number.isInteger(expectedAttempt) || expectedAttempt < 1 || result.irSchemaVersion !== IR_SCHEMA_VERSION) {
    throw new Error("invalid_document_ir_index_target");
  }
}

function parseIndexResult(value: unknown) {
  const result = record(value, "invalid_document_ir_index_result");
  exactKeys(result, ["page_count", "block_count", "replayed"], "invalid_document_ir_index_result");
  const pageCount = result.page_count;
  const blockCount = result.block_count;
  const replayed = result.replayed;
  if (typeof pageCount !== "number" || !Number.isSafeInteger(pageCount) || pageCount < 1
    || typeof blockCount !== "number" || !Number.isSafeInteger(blockCount) || blockCount < 0
    || typeof replayed !== "boolean") throw new Error("invalid_document_ir_index_result");
  return { pageCount, blockCount, replayed };
}

function record(value: unknown, error: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, keys: string[], error: string) {
  if (!keys.every((key) => key in value)) throw new Error(error);
}

function exactKeys(value: Record<string, unknown>, keys: string[], error: string) {
  requireKeys(value, keys, error);
  rejectUnknownKeys(value, keys, error);
}

function rejectUnknownKeys(value: Record<string, unknown>, keys: string[], error: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(error);
}

function optionalString(value: unknown, error: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1_000_000) throw new Error(error);
  return value;
}

function optionalInteger(value: unknown, error: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(error);
  return value;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validBbox(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("invalid_document_ir_bbox");
  }
  const bbox = value as number[];
  if (bbox[0] < 0 || bbox[1] < 0 || bbox[2] <= 0 || bbox[3] <= 0 || bbox[0] + bbox[2] > 1 || bbox[1] + bbox[3] > 1) {
    throw new Error("invalid_document_ir_bbox");
  }
  return bbox;
}

function sourceHashCandidates(parserVersion: string, text: string, bbox: number[], sourceSha256: string) {
  const material = (coordinates: string) => `${parserVersion}\n${text}\n${coordinates}\n${sourceSha256}`;
  const hash = (coordinates: string) => createHash("sha256").update(material(coordinates)).digest("hex");
  const javascriptCoordinates = bbox.join(",");
  // The first Docling emitters used Python float stringification, while JSON parsing
  // necessarily erases whether a zero arrived as `0` or `0.0`.
  const pythonFloatCoordinates = bbox.map((coordinate) => (
    Number.isInteger(coordinate) ? `${coordinate}.0` : String(coordinate)
  )).join(",");
  return new Set([hash(javascriptCoordinates), hash(pythonFloatCoordinates)]);
}

function tenantObjectKey(value: string, workspaceId: string) {
  return value.startsWith(`tenant/${workspaceId}/`) && !/(^|\/)\.\.?(\/|$)/.test(value);
}

function safeBlockId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) && value !== "." && value !== "..";
}

function jsonValue(value: unknown, error: string): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  throw new Error(error);
}

function sameJson(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
