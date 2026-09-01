import { createHash } from "node:crypto";

import type { JobHandler } from "@/features/jobs/bullmq-job-worker";
import { JobExecutionError } from "@/features/jobs/bullmq-job-worker";
import type { ObjectMetadata, ObjectRef } from "@/features/storage/storage";
import { ClamAvAdapterError, type ClamAvAdapter } from "./clamav-adapter";
import type { SourceAssetScanResult, SourceAssetScanTarget } from "./source-asset-scan";

type SourceAssetScans = {
  getTarget(jobId: string): Promise<SourceAssetScanTarget>;
  record(jobId: string, result: SourceAssetScanResult): Promise<{ status: string; replayed: boolean }>;
};

export type SourceObjectReader = {
  read(ref: ObjectRef, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
};

export function createFileScanHandler(input: {
  scans: SourceAssetScans;
  scanner: ClamAvAdapter;
  storage: { stat(ref: ObjectRef): Promise<ObjectMetadata> };
  reader: SourceObjectReader;
}): JobHandler {
  return async ({ job, signal, reportProgress }) => {
    const target = await input.scans.getTarget(job.id);
    if (target.assetId !== job.resourceId || target.workspaceId !== job.workspaceId) {
      throw new JobExecutionError("scan_target_mismatch", { retryable: false });
    }
    if (target.scanStatus === "clean") return { checkpoint: cleanCheckpoint(target) };
    if (target.scanStatus === "infected") {
      throw new JobExecutionError("malware_detected", { retryable: false });
    }
    if (target.scanStatus === "failed") {
      throw new JobExecutionError(target.scanErrorCode ?? "scan_already_failed", { retryable: false });
    }

    await reportProgress({ phase: "file_scan", percent: 10, messageCode: "scan_target_verified" });
    let metadata: ObjectMetadata;
    try {
      metadata = await input.storage.stat({ key: target.objectKey });
    } catch {
      return fail("storage_read_failed", true);
    }
    if (!metadataMatches(target, metadata)) {
      await input.scans.record(job.id, { status: "failed", errorCode: "object_metadata_mismatch" });
      throw new JobExecutionError("object_metadata_mismatch", { retryable: false });
    }

    await reportProgress({ phase: "file_scan", percent: 40, messageCode: "scanning_bytes" });
    let source: AsyncIterable<Uint8Array>;
    try {
      source = await input.reader.read({ key: target.objectKey }, signal);
    } catch {
      return fail("storage_read_failed", true);
    }
    const observed = observe(source);
    let scanResult;
    try {
      scanResult = await input.scanner.scan(observed.source, { maxBytes: target.sizeBytes, signal });
    } catch (error) {
      if (error instanceof ClamAvAdapterError) return fail(error.code, error.retryable);
      return fail("storage_read_failed", true);
    }

    const evidence = observed.evidence();
    if (evidence.sizeBytes !== target.sizeBytes || evidence.sha256 !== target.sha256) {
      await input.scans.record(job.id, {
        status: "failed",
        actualSha256: evidence.sha256,
        errorCode: "object_integrity_mismatch",
      });
      throw new JobExecutionError("object_integrity_mismatch", { retryable: false });
    }
    if (scanResult.status === "infected") {
      await input.scans.record(job.id, {
        status: "infected",
        actualSha256: evidence.sha256,
        signature: scanResult.signature,
      });
      throw new JobExecutionError("malware_detected", { retryable: false });
    }

    await input.scans.record(job.id, { status: "clean", actualSha256: evidence.sha256 });
    await reportProgress({ phase: "file_scan", percent: 100, messageCode: "scan_clean" }, cleanCheckpoint(target));
    return { checkpoint: cleanCheckpoint(target) };

    async function fail(code: string, retryable: boolean): Promise<never> {
      if (!retryable || job.attempt >= job.maxAttempts) {
        await input.scans.record(job.id, { status: "failed", errorCode: code });
      }
      throw new JobExecutionError(code, { retryable });
    }
  };
}

function metadataMatches(target: SourceAssetScanTarget, metadata: ObjectMetadata) {
  return metadata.ref.key === target.objectKey
    && metadata.sizeBytes === target.sizeBytes
    && metadata.sha256 === target.sha256
    && metadata.mimeType === target.mimeType;
}

function observe(source: AsyncIterable<Uint8Array>) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let finished = false;
  return {
    source: {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) throw new Error("invalid_storage_chunk");
          sizeBytes += chunk.byteLength;
          hash.update(chunk);
          yield chunk;
        }
        finished = true;
      },
    },
    evidence() {
      if (!finished) throw new Error("scan_stream_incomplete");
      return { sizeBytes, sha256: hash.digest("hex") };
    },
  };
}

function cleanCheckpoint(target: SourceAssetScanTarget) {
  return { scanStatus: "clean", assetId: target.assetId, sha256: target.sha256 };
}
