import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { createDocumentModule } from "@/features/documents/document-module";
import type { StorageAdapter, UploadIntent } from "@/features/storage/storage";

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
  };
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
  return createHash("sha256").update(JSON.stringify({
    filename: input.filename,
    size: input.size,
    mimeType: input.mimeType,
    sha256: input.sha256,
    mode: input.mode ?? null,
  })).digest("hex");
}
