import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { createDocumentModule } from "@/features/documents/document-module";
import {
  validateCompletedParts,
  type CompletedPart,
  type ObjectMetadata,
  type StorageAdapter,
  type UploadIntent,
} from "@/features/storage/storage";

type DocumentModule = ReturnType<typeof createDocumentModule>;
type UploadContext = { learnerId: string; userId?: string; workspaceId: string };
export type UploadInitInput = {
  filename: string;
  size: number;
  mimeType: string;
  sha256: string;
  mode?: "question_bank" | "study_material" | "mixed" | "unknown";
  idempotencyKey: string;
};
export type UploadCompleteInput = {
  assetId: string;
  uploadId: string;
  sha256: string;
  parts: CompletedPart[];
  idempotencyKey: string;
};

export function createUploadModule(input: {
  documents: DocumentModule;
  storage: StorageAdapter;
  newId?: () => string;
}) {
  const newId = input.newId ?? uuidv7;
  return {
    async initialize(context: UploadContext, request: UploadInitInput) {
      const requestHash = hashRequest(request);
      const existing = await input.documents.findUploadDraft(context, request.idempotencyKey, requestHash);
      if (existing) {
        if (!existing.storageUploadId) throw new Error("upload_draft_incomplete");
        const intent = intentFromDocument(existing);
        return {
          status: "replayed" as const,
          document: existing,
          plan: await input.storage.resumeUpload(intent, existing.storageUploadId),
        };
      }

      const documentId = newId();
      const versionId = newId();
      const assetId = newId();
      const objectKey = `tenant/${context.workspaceId}/${documentId}/${versionId}/source/${assetId}`;
      const intent: UploadIntent = {
        ref: { key: objectKey },
        mimeType: request.mimeType,
        sizeBytes: request.size,
        sha256: request.sha256,
      };
      const candidatePlan = await input.storage.createUpload(intent);
      try {
        const result = await input.documents.createUploadDraft(context, {
          documentId,
          versionId,
          assetId,
          filename: request.filename,
          mimeType: request.mimeType,
          size: request.size,
          sha256: request.sha256,
          objectKey,
          manualMode: request.mode,
          idempotencyKey: request.idempotencyKey,
          requestHash,
          storageUploadId: candidatePlan.uploadId,
          uploadExpiresAt: candidatePlan.expiresAt,
        });
        if (result.status === "created") return { status: "created" as const, document: result.document, plan: candidatePlan };

        await abortQuietly(input.storage, intent, candidatePlan.uploadId);
        if (!result.document.storageUploadId) throw new Error("upload_draft_incomplete");
        return {
          status: "replayed" as const,
          document: result.document,
          plan: await input.storage.resumeUpload(intentFromDocument(result.document), result.document.storageUploadId),
        };
      } catch (error) {
        await abortQuietly(input.storage, intent, candidatePlan.uploadId);
        throw error;
      }
    },

    async complete(actor: { learnerId: string; userId?: string }, request: UploadCompleteInput) {
      const parts = validateCompletedParts(request.parts);
      const completionRequestHash = hashJson({
        assetId: request.assetId,
        uploadId: request.uploadId,
        sha256: request.sha256,
        parts,
      });
      const document = await input.documents.findUploadByAsset(actor, request.assetId);
      if (!document || !document.storageUploadId) throw new Error("upload_not_found");
      if (document.storageUploadId !== request.uploadId || document.sha256 !== request.sha256) {
        throw new Error("upload_metadata_mismatch");
      }

      let metadata: ObjectMetadata;
      if (document.uploadState === "uploaded") {
        metadata = metadataFromDocument(document);
      } else {
        if (document.uploadState !== "initiated") throw new Error("upload_not_completable");
        metadata = await input.storage.completeUpload({
          ref: { key: document.objectKey },
          uploadId: request.uploadId,
          parts,
        });
      }
      assertMetadata(document, metadata);
      return input.documents.completeUpload({
        ...actor,
        workspaceId: document.workspaceId,
      }, {
        assetId: request.assetId,
        storageUploadId: request.uploadId,
        sizeBytes: metadata.sizeBytes,
        sha256: metadata.sha256,
        mimeType: metadata.mimeType,
        idempotencyKey: request.idempotencyKey,
        requestHash: completionRequestHash,
        jobRequestHash: hashJson({
          type: "file.scan",
          resourceId: request.assetId,
          priority: 0,
          budget: {},
          maxAttempts: 2,
        }),
        jobId: newId(),
        traceId: newId(),
      });
    },
  };
}

function metadataFromDocument(document: {
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}): ObjectMetadata {
  return {
    ref: { key: document.objectKey },
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
  };
}

function assertMetadata(
  document: { objectKey: string; mimeType: string; sizeBytes: number; sha256: string },
  metadata: ObjectMetadata,
) {
  if (metadata.ref.key !== document.objectKey
    || metadata.mimeType !== document.mimeType
    || metadata.sizeBytes !== document.sizeBytes
    || metadata.sha256 !== document.sha256) {
    throw new Error("upload_metadata_mismatch");
  }
}

function intentFromDocument(document: {
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}): UploadIntent {
  return {
    ref: { key: document.objectKey },
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
  };
}

async function abortQuietly(storage: StorageAdapter, intent: UploadIntent, uploadId: string) {
  await storage.abortUpload({ ref: intent.ref, uploadId }).catch(() => undefined);
}

function hashRequest(input: UploadInitInput) {
  return hashJson({
    filename: input.filename,
    size: input.size,
    mimeType: input.mimeType,
    sha256: input.sha256,
    mode: input.mode ?? null,
  });
}

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
