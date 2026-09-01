import type { JobHandler } from "@/features/jobs/bullmq-job-worker";
import { JobExecutionError } from "@/features/jobs/bullmq-job-worker";
import { DocumentServiceError, type DocumentParser } from "./document-service-client";
import type { DocumentParseResult, DocumentParseTarget } from "./document-parse";

type DocumentParses = {
  start(jobId: string): Promise<DocumentParseTarget>;
  succeed(jobId: string, result: DocumentParseResult): Promise<{ status: "ready" | "failed"; replayed: boolean }>;
  fail(jobId: string, errorCode: string): Promise<{ status: "ready" | "failed"; replayed: boolean }>;
};

export function createDocumentParseHandler(input: {
  parses: DocumentParses;
  parser: DocumentParser;
}): JobHandler {
  return async ({ job, signal, reportProgress }) => {
    const target = await input.parses.start(job.id);
    if (target.jobId !== job.id
      || target.workspaceId !== job.workspaceId
      || target.documentVersionId !== job.resourceId) {
      throw new JobExecutionError("parse_target_mismatch", { retryable: false });
    }
    if (target.parseStatus === "ready") {
      if (!target.result) throw new JobExecutionError("parse_result_missing", { retryable: false });
      return { checkpoint: checkpoint(target, target.result) };
    }

    await reportProgress({ phase: "document_parse", percent: 10, messageCode: "parse_target_verified" });
    let result: DocumentParseResult;
    try {
      result = await input.parser.parse(target, signal);
    } catch (error) {
      const serviceError = error instanceof DocumentServiceError
        ? error
        : new DocumentServiceError("document_service_unavailable", true);
      return fail(serviceError.code, serviceError.retryable);
    }
    await reportProgress({ phase: "document_parse", percent: 90, messageCode: "parse_result_received" });
    try {
      await input.parses.succeed(job.id, result);
    } catch {
      return fail("parse_persistence_failed", true);
    }
    await reportProgress(
      { phase: "document_parse", percent: 100, messageCode: "parse_ready" },
      checkpoint(target, result),
    );
    return { checkpoint: checkpoint(target, result) };

    async function fail(code: string, retryable: boolean): Promise<never> {
      if (!retryable || job.attempt >= job.maxAttempts) {
        await input.parses.fail(job.id, code);
      }
      throw new JobExecutionError(code, { retryable });
    }
  };
}

function checkpoint(target: DocumentParseTarget, result: DocumentParseResult) {
  return {
    parseStatus: "ready",
    documentVersionId: target.documentVersionId,
    irObjectKey: result.irObjectKey,
    irSha256: result.irSha256,
    parser: result.parser,
    parserVersion: result.parserVersion,
    pageCount: result.pageCount,
  };
}
