import type { PostgresRuntime } from "@/db/postgres/runtime";

export type SourceAssetScanTarget = {
  jobId: string;
  workspaceId: string;
  assetId: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  scanStatus: "pending" | "clean" | "infected" | "failed";
  scanErrorCode?: string;
};

export type SourceAssetScanResult =
  | { status: "clean"; actualSha256: string }
  | { status: "infected"; actualSha256: string; signature: string }
  | { status: "failed"; actualSha256?: string; errorCode: string };

export function createSourceAssetScanModule(runtime: PostgresRuntime, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    async getTarget(jobId: string): Promise<SourceAssetScanTarget> {
      assertUuidV7(jobId, "invalid_scan_job_id");
      return runtime.withTenant({ learnerId: jobId }, async ({ query }) => {
        const result = await query<{ result: Record<string, unknown> }>(
          "SELECT read_source_asset_scan_target_v1($1) AS result",
          [jobId],
        );
        const row = result.rows[0]?.result;
        if (!row) throw new Error("scan_target_no_result");
        return targetFromRaw(row);
      });
    },

    async record(jobId: string, result: SourceAssetScanResult): Promise<{
      status: SourceAssetScanResult["status"];
      replayed: boolean;
    }> {
      assertUuidV7(jobId, "invalid_scan_job_id");
      validateResult(result);
      const scannedAt = now();
      if (!Number.isFinite(scannedAt.getTime())) throw new Error("invalid_scan_timestamp");
      return runtime.withTenant({ learnerId: jobId }, async ({ query }) => {
        const recorded = await query<{ result: { status: SourceAssetScanResult["status"]; replayed: boolean } }>(
          "SELECT record_source_asset_scan_v1($1,$2,$3,$4,$5,$6) AS result",
          [
            jobId,
            result.status,
            "actualSha256" in result ? result.actualSha256 ?? null : null,
            result.status === "infected" ? result.signature : null,
            result.status === "failed" ? result.errorCode : null,
            scannedAt,
          ],
        );
        const row = recorded.rows[0]?.result;
        if (!row || !["clean", "infected", "failed"].includes(row.status) || typeof row.replayed !== "boolean") {
          throw new Error("invalid_scan_record_result");
        }
        return row;
      });
    },
  };
}

function targetFromRaw(row: Record<string, unknown>): SourceAssetScanTarget {
  const target = {
    jobId: stringField(row.job_id),
    workspaceId: stringField(row.workspace_id),
    assetId: stringField(row.asset_id),
    objectKey: stringField(row.object_key),
    sizeBytes: numberField(row.size_bytes),
    sha256: stringField(row.sha256),
    mimeType: stringField(row.mime_type),
    scanStatus: stringField(row.scan_status),
    ...(row.scan_error_code ? { scanErrorCode: stringField(row.scan_error_code) } : {}),
  };
  assertUuidV7(target.jobId, "invalid_scan_target");
  assertUuidV7(target.workspaceId, "invalid_scan_target");
  assertUuidV7(target.assetId, "invalid_scan_target");
  if (!Number.isSafeInteger(target.sizeBytes) || target.sizeBytes < 1 || target.sizeBytes > 200 * 1024 * 1024
    || !/^[0-9a-f]{64}$/.test(target.sha256)
    || !["pending", "clean", "infected", "failed"].includes(target.scanStatus)) {
    throw new Error("invalid_scan_target");
  }
  return target as SourceAssetScanTarget;
}

function validateResult(result: SourceAssetScanResult) {
  if (("actualSha256" in result && result.actualSha256 !== undefined
      && !/^[0-9a-f]{64}$/.test(result.actualSha256))
    || (result.status === "infected" && !/^[\x20-\x7e]{1,200}$/.test(result.signature))
    || (result.status === "failed" && !/^[a-z][a-z0-9_.-]{0,119}$/.test(result.errorCode))) {
    throw new Error("invalid_scan_result");
  }
}

function stringField(value: unknown) {
  if (typeof value !== "string") throw new Error("invalid_scan_target");
  return value;
}

function numberField(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("invalid_scan_target");
  return number;
}

function assertUuidV7(value: string, code: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(code);
  }
}
