import { v7 as uuidv7 } from "uuid";

export type ObjectRef = { key: string };
export type UploadIntent = {
  ref: ObjectRef;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};
export type UploadPlan = {
  uploadId: string;
  partSizeBytes: number;
  expiresAt: string;
  parts: Array<{ partNumber: number; url: string }>;
};
export type CompletedPart = { partNumber: number; etag: string };
export type ObjectMetadata = {
  ref: ObjectRef;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  etag?: string;
};

export interface StorageAdapter {
  createUpload(intent: UploadIntent): Promise<UploadPlan>;
  resumeUpload(intent: UploadIntent, uploadId: string): Promise<UploadPlan>;
  completeUpload(input: { ref: ObjectRef; uploadId: string; parts: CompletedPart[] }): Promise<ObjectMetadata>;
  abortUpload(input: { ref: ObjectRef; uploadId: string }): Promise<void>;
  stat(ref: ObjectRef): Promise<ObjectMetadata>;
  createReadUrl(ref: ObjectRef, ttlSeconds: number): Promise<string>;
  deleteMany(refs: ObjectRef[]): Promise<void>;
}

export const STORAGE_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const STORAGE_UPLOAD_TTL_SECONDS = 5 * 60;
export const STORAGE_MAX_OBJECT_BYTES = 200 * 1024 * 1024;

export function createMemoryStorageAdapter(options: {
  now?: () => Date;
  newId?: () => string;
} = {}): StorageAdapter {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? uuidv7;
  const uploads = new Map<string, UploadIntent>();
  const objects = new Map<string, ObjectMetadata>();

  return {
    async createUpload(intent) {
      validateUploadIntent(intent);
      const uploadId = newId();
      const expiresAt = uploadExpiry(now());
      uploads.set(uploadId, structuredClone(intent));
      return {
        uploadId,
        partSizeBytes: STORAGE_PART_SIZE_BYTES,
        expiresAt,
        parts: partNumbers(intent.sizeBytes).map((partNumber) => ({
          partNumber,
          url: `memory://${encodeURIComponent(uploadId)}/${partNumber}`,
        })),
      };
    },

    async resumeUpload(intent, uploadId) {
      validateUploadIntent(intent);
      const existing = uploads.get(uploadId);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(intent)) throw new Error("storage_upload_not_found");
      return memoryPlan(intent, uploadId, uploadExpiry(now()));
    },

    async completeUpload(input) {
      validateObjectRef(input.ref);
      const intent = uploads.get(input.uploadId);
      if (!intent || intent.ref.key !== input.ref.key) throw new Error("storage_upload_not_found");
      const parts = validateCompletedParts(input.parts);
      if (parts.length !== partNumbers(intent.sizeBytes).length) throw new Error("invalid_storage_parts");
      const metadata: ObjectMetadata = {
        ref: structuredClone(intent.ref),
        sizeBytes: intent.sizeBytes,
        sha256: intent.sha256,
        mimeType: intent.mimeType,
        etag: '"memory-complete"',
      };
      uploads.delete(input.uploadId);
      objects.set(intent.ref.key, metadata);
      return structuredClone(metadata);
    },

    async abortUpload(input) {
      validateObjectRef(input.ref);
      const intent = uploads.get(input.uploadId);
      if (!intent || intent.ref.key !== input.ref.key) throw new Error("storage_upload_not_found");
      uploads.delete(input.uploadId);
    },

    async stat(ref) {
      validateObjectRef(ref);
      const metadata = objects.get(ref.key);
      if (!metadata) throw new Error("storage_object_not_found");
      return structuredClone(metadata);
    },

    async createReadUrl(ref, ttlSeconds) {
      validateReadTtl(ttlSeconds);
      if (!objects.has(ref.key)) throw new Error("storage_object_not_found");
      return `memory://${encodeURIComponent(ref.key)}?expires=${ttlSeconds}`;
    },

    async deleteMany(refs) {
      for (const ref of refs) {
        validateObjectRef(ref);
        objects.delete(ref.key);
      }
    },
  };

  function memoryPlan(intent: UploadIntent, uploadId: string, expiresAt: string): UploadPlan {
    return {
      uploadId,
      partSizeBytes: STORAGE_PART_SIZE_BYTES,
      expiresAt,
      parts: partNumbers(intent.sizeBytes).map((partNumber) => ({
        partNumber,
        url: `memory://${encodeURIComponent(uploadId)}/${partNumber}`,
      })),
    };
  }
}

export function validateUploadIntent(intent: UploadIntent) {
  validateObjectRef(intent.ref);
  if (!Number.isSafeInteger(intent.sizeBytes)
    || intent.sizeBytes < 1
    || intent.sizeBytes > STORAGE_MAX_OBJECT_BYTES) {
    throw new Error("invalid_storage_object_size");
  }
  if (!/^[0-9a-f]{64}$/.test(intent.sha256)) throw new Error("invalid_storage_sha256");
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(intent.mimeType)) {
    throw new Error("invalid_storage_mime_type");
  }
}

export function validateObjectRef(ref: ObjectRef) {
  if (!ref || typeof ref.key !== "string"
    || ref.key.length < 10
    || ref.key.length > 1024
    || !/^tenant\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[A-Za-z0-9._/-]+$/.test(ref.key)
    || ref.key.includes("//")
    || ref.key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("invalid_storage_object_key");
  }
}

export function validateCompletedParts(parts: CompletedPart[]): CompletedPart[] {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 10_000) {
    throw new Error("invalid_storage_parts");
  }
  const sorted = parts.map((part) => ({ ...part })).sort((a, b) => a.partNumber - b.partNumber);
  for (let index = 0; index < sorted.length; index += 1) {
    const part = sorted[index];
    if (!part
      || part.partNumber !== index + 1
      || typeof part.etag !== "string"
      || !part.etag.trim()
      || part.etag.length > 256) {
      throw new Error("invalid_storage_parts");
    }
  }
  return sorted;
}

export function partNumbers(sizeBytes: number): number[] {
  return Array.from({ length: Math.ceil(sizeBytes / STORAGE_PART_SIZE_BYTES) }, (_, index) => index + 1);
}

export function uploadExpiry(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_storage_timestamp");
  return new Date(now.getTime() + STORAGE_UPLOAD_TTL_SECONDS * 1000).toISOString();
}

export function validateReadTtl(ttlSeconds: number) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) {
    throw new Error("invalid_storage_read_ttl");
  }
}
