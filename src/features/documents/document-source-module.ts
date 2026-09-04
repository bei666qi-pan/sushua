import type { PostgresRuntime } from "@/db/postgres/runtime";

const BLOCK_TYPES = [
  "heading", "paragraph", "list", "list_item", "table", "table_cell", "formula",
  "image", "question_candidate", "answer_candidate", "text", "unknown",
] as const;

export type DocumentBlockType = (typeof BLOCK_TYPES)[number];
type SourceActor = { learnerId: string; userId?: string };
type PageCursor = { kind: "pages"; documentVersionId: string; pageNumber: number; id: string };
type BlockCursor = { kind: "blocks"; pageId: string; readingOrder: number; id: string };
type PageRow = {
  id: string;
  document_version_id: string;
  page_number: number;
  width: number;
  height: number;
  rendered_image_key: string | null;
};
type BlockRow = {
  id: string;
  page_id: string;
  document_version_id: string;
  parent_block_id: string | null;
  block_type: DocumentBlockType;
  text: string | null;
  markdown: string | null;
  bbox: [number, number, number, number];
  reading_order: number;
  confidence: number;
  heading_level: number | null;
  table_structure: unknown;
  formula_latex: string | null;
  image_object_key: string | null;
  source_hash: string;
};

export type SourcePage = {
  id: string;
  documentVersionId: string;
  pageNumber: number;
  width: number;
  height: number;
  renderedImageKey?: string;
};

export type SourceBlock = {
  id: string;
  pageId: string;
  documentVersionId: string;
  parentBlockId?: string;
  blockType: DocumentBlockType;
  text?: string;
  markdown?: string;
  bbox: [number, number, number, number];
  readingOrder: number;
  confidence: number;
  headingLevel?: number;
  tableStructure?: unknown;
  formulaLatex?: string;
  imageObjectKey?: string;
  sourceHash: string;
};

export function isDocumentBlockType(value: string): value is DocumentBlockType {
  return (BLOCK_TYPES as readonly string[]).includes(value);
}

export function createDocumentSourceModule(runtime: PostgresRuntime) {
  return {
    async listPages(actor: SourceActor, input: {
      documentVersionId: string;
      cursor?: string;
      limit?: number;
    }): Promise<{ items: SourcePage[]; nextCursor?: string }> {
      assertUuidV7(actor.learnerId, "invalid_source_learner");
      assertUuidV7(input.documentVersionId, "invalid_document_version_id");
      const limit = normalizeLimit(input.limit);
      const cursor = input.cursor === undefined ? undefined : decodePageCursor(input.cursor, input.documentVersionId);
      return runtime.withTenant(actor, async ({ query }) => {
        const version = await query<{ id: string }>("SELECT id FROM document_versions WHERE id = $1", [input.documentVersionId]);
        if (!version.rows[0]) throw new Error("document_version_not_found");
        const result = await query<PageRow>(
          `SELECT id, document_version_id, page_number, width, height, rendered_image_key
             FROM pages
            WHERE document_version_id = $1
              AND ($2::integer IS NULL OR page_number > $2
                OR (page_number = $2 AND id > $3::uuid))
            ORDER BY page_number ASC, id ASC
            LIMIT $4`,
          [input.documentVersionId, cursor?.pageNumber ?? null, cursor?.id ?? null, limit + 1],
        );
        const rows = result.rows.slice(0, limit);
        const last = rows.at(-1);
        return {
          items: rows.map(pageFromRow),
          ...(result.rows.length > limit && last ? { nextCursor: encodeCursor({
            kind: "pages", documentVersionId: input.documentVersionId, pageNumber: last.page_number, id: last.id,
          }) } : {}),
        };
      });
    },

    async listBlocks(actor: SourceActor, input: {
      pageId: string;
      cursor?: string;
      limit?: number;
      blockTypes?: DocumentBlockType[];
      minConfidence?: number;
    }): Promise<{ items: SourceBlock[]; nextCursor?: string }> {
      assertUuidV7(actor.learnerId, "invalid_source_learner");
      assertUuidV7(input.pageId, "invalid_page_id");
      const limit = normalizeLimit(input.limit);
      const cursor = input.cursor === undefined ? undefined : decodeBlockCursor(input.cursor, input.pageId);
      if (input.blockTypes?.some((type) => !isDocumentBlockType(type))) throw new Error("invalid_block_type");
      if (input.minConfidence !== undefined && (!Number.isFinite(input.minConfidence) || input.minConfidence < 0 || input.minConfidence > 1)) {
        throw new Error("invalid_min_confidence");
      }
      return runtime.withTenant(actor, async ({ query }) => {
        const page = await query<{ id: string }>("SELECT id FROM pages WHERE id = $1", [input.pageId]);
        if (!page.rows[0]) throw new Error("page_not_found");
        const result = await query<BlockRow>(
          `SELECT id, page_id, document_version_id, parent_block_id, block_type, text, markdown, bbox,
                  reading_order, confidence, heading_level, table_structure, formula_latex, image_object_key, source_hash
             FROM blocks
            WHERE page_id = $1
              AND deleted_at IS NULL
              AND (cardinality($2::document_block_type[]) = 0 OR block_type = ANY($2::document_block_type[]))
              AND ($3::double precision IS NULL OR confidence >= $3)
              AND ($4::integer IS NULL OR reading_order > $4
                OR (reading_order = $4 AND id > $5::uuid))
            ORDER BY reading_order ASC, id ASC
            LIMIT $6`,
          [input.pageId, input.blockTypes ?? [], input.minConfidence ?? null,
            cursor?.readingOrder ?? null, cursor?.id ?? null, limit + 1],
        );
        const rows = result.rows.slice(0, limit);
        const last = rows.at(-1);
        return {
          items: rows.map(blockFromRow),
          ...(result.rows.length > limit && last ? { nextCursor: encodeCursor({
            kind: "blocks", pageId: input.pageId, readingOrder: last.reading_order, id: last.id,
          }) } : {}),
        };
      });
    },
  };
}

function pageFromRow(row: PageRow): SourcePage {
  return {
    id: row.id,
    documentVersionId: row.document_version_id,
    pageNumber: row.page_number,
    width: row.width,
    height: row.height,
    ...(row.rendered_image_key ? { renderedImageKey: row.rendered_image_key } : {}),
  };
}

function blockFromRow(row: BlockRow): SourceBlock {
  return {
    id: row.id,
    pageId: row.page_id,
    documentVersionId: row.document_version_id,
    ...(row.parent_block_id ? { parentBlockId: row.parent_block_id } : {}),
    blockType: row.block_type,
    ...(row.text === null ? {} : { text: row.text }),
    ...(row.markdown === null ? {} : { markdown: row.markdown }),
    bbox: row.bbox,
    readingOrder: row.reading_order,
    confidence: row.confidence,
    ...(row.heading_level === null ? {} : { headingLevel: row.heading_level }),
    ...(row.table_structure === null ? {} : { tableStructure: row.table_structure }),
    ...(row.formula_latex === null ? {} : { formulaLatex: row.formula_latex }),
    ...(row.image_object_key === null ? {} : { imageObjectKey: row.image_object_key }),
    sourceHash: row.source_hash,
  };
}

function normalizeLimit(limit: number | undefined) {
  const value = limit ?? 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error("invalid_source_limit");
  return value;
}

function decodePageCursor(encoded: string, documentVersionId: string): PageCursor {
  const cursor = decodeCursor(encoded);
  const pageNumber = cursor.pageNumber;
  const id = cursor.id;
  if (cursor.kind !== "pages" || cursor.documentVersionId !== documentVersionId
    || typeof pageNumber !== "number" || !Number.isSafeInteger(pageNumber) || pageNumber < 1
    || typeof id !== "string" || !uuidV7(id)) {
    throw new Error("invalid_source_cursor");
  }
  return { kind: "pages", documentVersionId, pageNumber, id };
}

function decodeBlockCursor(encoded: string, pageId: string): BlockCursor {
  const cursor = decodeCursor(encoded);
  const readingOrder = cursor.readingOrder;
  const id = cursor.id;
  if (cursor.kind !== "blocks" || cursor.pageId !== pageId
    || typeof readingOrder !== "number" || !Number.isSafeInteger(readingOrder) || readingOrder < 0
    || typeof id !== "string" || !uuidV7(id)) {
    throw new Error("invalid_source_cursor");
  }
  return { kind: "blocks", pageId, readingOrder, id };
}

function decodeCursor(encoded: string): Record<string, unknown> {
  if (!encoded || encoded.length > 1024) throw new Error("invalid_source_cursor");
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_source_cursor");
    return value as Record<string, unknown>;
  } catch {
    throw new Error("invalid_source_cursor");
  }
}

function encodeCursor(value: PageCursor | BlockCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function assertUuidV7(value: string, code: string) {
  if (!uuidV7(value)) throw new Error(code);
}

function uuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
