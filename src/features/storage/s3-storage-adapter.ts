import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  partNumbers,
  STORAGE_PART_SIZE_BYTES,
  STORAGE_UPLOAD_TTL_SECONDS,
  uploadExpiry,
  validateCompletedParts,
  validateObjectRef,
  validateReadTtl,
  validateUploadIntent,
  type ObjectMetadata,
  type StorageAdapter,
} from "./storage";

type S3Transport = { send(command: unknown): Promise<Record<string, unknown>> };
type Presign = (
  client: S3Transport,
  command: unknown,
  options: { expiresIn: number },
) => Promise<string>;

export function createS3StorageAdapter(input: {
  bucket: string;
  client?: S3Transport;
  clientConfig?: S3ClientConfig;
  presign?: Presign;
  now?: () => Date;
}): StorageAdapter {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("invalid_storage_bucket");
  const client: S3Transport = input.client ?? new S3Client(input.clientConfig ?? {});
  const presign: Presign = input.presign ?? ((transport, command, options) =>
    getSignedUrl(transport as S3Client, command as UploadPartCommand, options));
  const now = input.now ?? (() => new Date());

  return {
    async createUpload(intent) {
      validateUploadIntent(intent);
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: intent.ref.key,
        ContentType: intent.mimeType,
        Metadata: { sha256: intent.sha256 },
      }));
      const uploadId = typeof created.UploadId === "string" ? created.UploadId : "";
      if (!uploadId) throw new Error("storage_create_upload_failed");
      let parts: Array<{ partNumber: number; url: string }>;
      try {
        parts = await Promise.all(partNumbers(intent.sizeBytes).map(async (partNumber) => ({
          partNumber,
          url: await presign(client, new UploadPartCommand({
            Bucket: input.bucket,
            Key: intent.ref.key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }), { expiresIn: STORAGE_UPLOAD_TTL_SECONDS }),
        })));
      } catch (error) {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: input.bucket,
          Key: intent.ref.key,
          UploadId: uploadId,
        })).catch(() => undefined);
        throw error;
      }
      return {
        uploadId,
        partSizeBytes: STORAGE_PART_SIZE_BYTES,
        expiresAt: uploadExpiry(now()),
        parts,
      };
    },

    async resumeUpload(intent, uploadId) {
      validateUploadIntent(intent);
      if (!uploadId || uploadId.length > 1024) throw new Error("invalid_storage_upload_id");
      return {
        uploadId,
        partSizeBytes: STORAGE_PART_SIZE_BYTES,
        expiresAt: uploadExpiry(now()),
        parts: await signParts(intent.ref.key, intent.sizeBytes, uploadId),
      };
    },

    async completeUpload(completion) {
      validateObjectRef(completion.ref);
      if (!completion.uploadId || completion.uploadId.length > 1024) throw new Error("invalid_storage_upload_id");
      const parts = validateCompletedParts(completion.parts);
      try {
        await client.send(new CompleteMultipartUploadCommand({
          Bucket: input.bucket,
          Key: completion.ref.key,
          UploadId: completion.uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
          },
        }));
      } catch (error) {
        if (!isNoSuchUpload(error)) throw error;
      }
      return stat(completion.ref);
    },

    async abortUpload(abort) {
      validateObjectRef(abort.ref);
      if (!abort.uploadId || abort.uploadId.length > 1024) throw new Error("invalid_storage_upload_id");
      await client.send(new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: abort.ref.key,
        UploadId: abort.uploadId,
      }));
    },

    stat,

    async createReadUrl(ref, ttlSeconds) {
      validateObjectRef(ref);
      validateReadTtl(ttlSeconds);
      return presign(client, new GetObjectCommand({ Bucket: input.bucket, Key: ref.key }), { expiresIn: ttlSeconds });
    },

    async deleteMany(refs) {
      if (refs.length === 0) return;
      if (refs.length > 1000) throw new Error("too_many_storage_objects");
      for (const ref of refs) validateObjectRef(ref);
      await client.send(new DeleteObjectsCommand({
        Bucket: input.bucket,
        Delete: { Quiet: true, Objects: refs.map((ref) => ({ Key: ref.key })) },
      }));
    },
  };

  function signParts(key: string, sizeBytes: number, uploadId: string) {
    return Promise.all(partNumbers(sizeBytes).map(async (partNumber) => ({
      partNumber,
      url: await presign(client, new UploadPartCommand({
        Bucket: input.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }), { expiresIn: STORAGE_UPLOAD_TTL_SECONDS }),
    })));
  }

  async function stat(ref: { key: string }): Promise<ObjectMetadata> {
    validateObjectRef(ref);
    let head: Record<string, unknown>;
    try {
      head = await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: ref.key }));
    } catch (error) {
      if (isNotFound(error)) throw new Error("storage_object_not_found");
      throw error;
    }
    const sizeBytes = head.ContentLength;
    const mimeType = head.ContentType;
    const metadata = head.Metadata;
    const sha256 = metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).sha256
      : undefined;
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1
      || typeof mimeType !== "string"
      || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error("invalid_storage_object_metadata");
    }
    return {
      ref: { key: ref.key },
      sizeBytes,
      sha256,
      mimeType,
      ...(typeof head.ETag === "string" ? { etag: head.ETag } : {}),
    };
  }
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}

function isNoSuchUpload(error: unknown) {
  return !!error && typeof error === "object" && "name" in error && error.name === "NoSuchUpload";
}
