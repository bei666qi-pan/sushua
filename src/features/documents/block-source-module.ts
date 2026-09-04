import type { PostgresRuntime } from "@/db/postgres/runtime";
import type { ObjectMetadata, ObjectRef, StorageAdapter } from "@/features/storage/storage";

const SOURCE_URL_TTL_SECONDS = 5 * 60;
const MAX_SOURCE_QUOTE_CHARS = 1_000;

type SourceActor = { learnerId: string; userId?: string };
type SourceStorage = Pick<StorageAdapter, "stat" | "createReadUrl">;
type BlockLocationRow = {
  workspace_id: string;
  block_id: string;
  block_type: string;
  block_text: string | null;
  block_markdown: string | null;
  bbox: [number, number, number, number];
  confidence: number;
  source_hash: string;
  page_id: string;
  document_version_id: string;
  page_number: number;
  width: number;
  height: number;
  document_id: string;
};
type SourceAssetRow = {
  object_key: string;
  mime_type: string;
  size_bytes: string | number;
  sha256: string;
  scan_status: "clean" | "pending" | "infected" | "failed";
};

export type BlockSourceLocation = {
  block: {
    id: string;
    blockType: string;
    bbox: [number, number, number, number];
    confidence: number;
    sourceHash: string;
  };
  page: {
    id: string;
    documentVersionId: string;
    pageNumber: number;
    width: number;
    height: number;
  };
  documentVersion: { id: string; documentId: string };
  sourceQuote: string;
  sourceUrl: string;
  sourceUrlExpiresInSeconds: number;
};

/**
 * Resolves a source location through one small seam: RLS authorizes the Block
 * before this Module touches object storage, then object metadata is checked
 * before a bounded read URL is issued.
 */
export function createBlockSourceModule(runtime: PostgresRuntime, storage: SourceStorage) {
  return {
    async getSource(actor: SourceActor, blockId: string): Promise<BlockSourceLocation> {
      assertUuidV7(actor.learnerId, "invalid_source_learner");
      assertUuidV7(blockId, "invalid_block_id");
      const location = await runtime.withTenant(actor, async ({ query }) => {
        const block = await query<BlockLocationRow>(
          `SELECT b.workspace_id, b.id AS block_id, b.block_type, b.text AS block_text, b.markdown AS block_markdown,
                  b.bbox, b.confidence, b.source_hash,
                  p.id AS page_id, p.document_version_id, p.page_number, p.width, p.height,
                  dv.document_id
             FROM blocks b
             JOIN pages p
               ON p.id = b.page_id
              AND p.workspace_id = b.workspace_id
              AND p.document_version_id = b.document_version_id
             JOIN document_versions dv
               ON dv.id = b.document_version_id
              AND dv.workspace_id = b.workspace_id
             JOIN documents d
               ON d.id = dv.document_id
              AND d.workspace_id = b.workspace_id
            WHERE b.id = $1
              AND b.deleted_at IS NULL
              AND d.deleted_at IS NULL`,
          [blockId],
        );
        const blockRow = block.rows[0];
        if (!blockRow) throw new Error("block_not_found");
        const assets = await query<SourceAssetRow>(
          `SELECT object_key, mime_type, size_bytes, sha256, scan_status
             FROM source_assets
            WHERE workspace_id = $1
              AND document_version_id = $2
              AND kind = 'original'
            ORDER BY created_at ASC, id ASC
            LIMIT 2`,
          [blockRow.workspace_id, blockRow.document_version_id],
        );
        if (assets.rows.length !== 1 || assets.rows[0].scan_status !== "clean") {
          throw new Error("source_asset_unavailable");
        }
        return { block: blockRow, asset: assets.rows[0] };
      });

      const ref: ObjectRef = { key: location.asset.object_key };
      const metadata = await safeStat(storage, ref, location.asset);
      if (!metadata) throw new Error("source_asset_unavailable");
      let sourceUrl: string;
      try {
        sourceUrl = await storage.createReadUrl(ref, SOURCE_URL_TTL_SECONDS);
      } catch {
        throw new Error("source_asset_unavailable");
      }
      return {
        block: {
          id: location.block.block_id,
          blockType: location.block.block_type,
          bbox: location.block.bbox,
          confidence: location.block.confidence,
          sourceHash: location.block.source_hash,
        },
        page: {
          id: location.block.page_id,
          documentVersionId: location.block.document_version_id,
          pageNumber: location.block.page_number,
          width: location.block.width,
          height: location.block.height,
        },
        documentVersion: {
          id: location.block.document_version_id,
          documentId: location.block.document_id,
        },
        sourceQuote: truncateQuote(location.block.block_text ?? location.block.block_markdown ?? ""),
        sourceUrl,
        sourceUrlExpiresInSeconds: SOURCE_URL_TTL_SECONDS,
      };
    },
  };
}

async function safeStat(storage: SourceStorage, ref: ObjectRef, asset: SourceAssetRow): Promise<ObjectMetadata | undefined> {
  try {
    const metadata = await storage.stat(ref);
    const sizeBytes = Number(asset.size_bytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1
      || metadata.ref.key !== ref.key
      || metadata.sizeBytes !== sizeBytes
      || metadata.sha256 !== asset.sha256
      || metadata.mimeType !== asset.mime_type) {
      return undefined;
    }
    return metadata;
  } catch {
    return undefined;
  }
}

function truncateQuote(value: string): string {
  return Array.from(value).slice(0, MAX_SOURCE_QUOTE_CHARS).join("");
}

function assertUuidV7(value: string, code: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(code);
  }
}
