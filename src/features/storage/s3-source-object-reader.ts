import { GetObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

import type { SourceObjectReader } from "@/features/security/file-scan-handler";
import { validateObjectRef } from "./storage";

type S3ReadTransport = {
  send(
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ Body?: unknown }>;
};

export function createS3SourceObjectReader(input: {
  bucket: string;
  client?: S3ReadTransport;
  clientConfig?: S3ClientConfig;
}): SourceObjectReader {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("invalid_storage_bucket");
  const client: S3ReadTransport = input.client ?? (new S3Client(input.clientConfig ?? {}) as S3ReadTransport);
  return {
    async read(ref, signal) {
      validateObjectRef(ref);
      if (signal.aborted) throw new Error("storage_read_aborted");
      let response: { Body?: unknown };
      try {
        response = await client.send(
          new GetObjectCommand({ Bucket: input.bucket, Key: ref.key }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (signal.aborted || isAbort(error)) throw new Error("storage_read_aborted");
        if (isNotFound(error)) throw new Error("storage_object_not_found");
        throw error;
      }
      if (!isAsyncBytes(response.Body)) throw new Error("invalid_storage_object_body");
      return response.Body;
    },
  };
}

function isAsyncBytes(value: unknown): value is AsyncIterable<Uint8Array> {
  return !!value
    && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
}

function isAbort(error: unknown) {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NoSuchKey"
    || candidate.name === "NotFound"
    || candidate.$metadata?.httpStatusCode === 404;
}
