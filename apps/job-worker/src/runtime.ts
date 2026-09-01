import { createPostgresRuntime } from "@/db/postgres/runtime";
import { createDocumentParseHandler } from "@/features/documents/document-parse-handler";
import { createDocumentParseModule } from "@/features/documents/document-parse";
import { createDocumentServiceClient, type DocumentParser } from "@/features/documents/document-service-client";
import { createBullMqJobWorker } from "@/features/jobs/bullmq-job-worker";
import { createBullMqJobDispatcher } from "@/features/jobs/bullmq-job-dispatcher";
import { createJobModule } from "@/features/jobs/job-module";
import { createClamAvAdapter } from "@/features/security/clamav-adapter";
import { createFileScanHandler } from "@/features/security/file-scan-handler";
import { createSourceAssetScanModule } from "@/features/security/source-asset-scan";
import { createS3SourceObjectReader } from "@/features/storage/s3-source-object-reader";
import { createS3StorageAdapter } from "@/features/storage/s3-storage-adapter";
import type { JobWorkerConfig } from "./config";
import type { ClamAvAdapter } from "@/features/security/clamav-adapter";
import type { SourceObjectReader } from "@/features/security/file-scan-handler";
import type { ObjectMetadata, ObjectRef } from "@/features/storage/storage";

export function createJobWorkerRuntime(
  config: JobWorkerConfig,
  onError: (error: Error) => void,
  overrides: {
    storage?: { stat(ref: ObjectRef): Promise<ObjectMetadata> };
    reader?: SourceObjectReader;
    scanner?: ClamAvAdapter;
    parser?: DocumentParser;
  } = {},
) {
  const database = createPostgresRuntime({ connectionString: config.databaseUrl, maxConnections: config.concurrency + 1 });
  const jobs = createJobModule(database);
  const scans = createSourceAssetScanModule(database);
  const parses = createDocumentParseModule(database);
  const storage = overrides.storage ?? createS3StorageAdapter(config.s3);
  const reader = overrides.reader ?? createS3SourceObjectReader(config.s3);
  const scanner = overrides.scanner ?? createClamAvAdapter(config.clamav);
  const parser = overrides.parser ?? createDocumentServiceClient(config.documentService);
  const dispatcher = createBullMqJobDispatcher({ queueName: config.queueName, redisUrl: config.redisUrl });
  const worker = createBullMqJobWorker({
    queueName: config.queueName,
    redisUrl: config.redisUrl,
    jobs,
    handlers: {
      "file.scan": createFileScanHandler({ scans, scanner, storage, reader, dispatcher }),
      "document.parse": createDocumentParseHandler({ parses, parser }),
    },
    leaseSeconds: config.leaseSeconds,
    concurrency: config.concurrency,
    onError,
  });
  let closed = false;
  return {
    waitUntilReady: () => worker.waitUntilReady(),
    async close() {
      if (closed) return;
      closed = true;
      await worker.close();
      await dispatcher.close();
      await database.close();
    },
  };
}
