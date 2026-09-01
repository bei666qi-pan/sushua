import {
  parseDocumentParseResult,
  type DocumentParseResult,
  type DocumentParseTarget,
} from "./document-parse";

export class DocumentServiceError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "DocumentServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type DocumentParser = {
  parse(target: DocumentParseTarget, signal: AbortSignal): Promise<DocumentParseResult>;
};

export function createDocumentServiceClient(input: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): DocumentParser {
  const endpoint = parseEndpoint(input.baseUrl);
  if (typeof input.token !== "string" || input.token.length < 32 || input.token.length > 512
    || /[\r\n]/.test(input.token)) {
    throw new Error("invalid_document_service_token");
  }
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1_800_000) {
    throw new Error("invalid_document_service_timeout");
  }

  return {
    async parse(target, signal) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
      const requestSignal = AbortSignal.any([signal, timeoutController.signal]);
      try {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${input.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody(target)),
            signal: requestSignal,
          });
        } catch {
          if (signal.aborted) throw new DocumentServiceError("document_parse_cancelled", false);
          throw new DocumentServiceError("document_service_unavailable", true);
        }

        if (!response.ok) {
          if (response.status === 408 || response.status === 429 || response.status >= 500) {
            throw new DocumentServiceError("document_service_unavailable", true);
          }
          throw new DocumentServiceError("document_request_rejected", false);
        }
        const contentLength = Number(response.headers.get("content-length"));
        if ((Number.isFinite(contentLength) && contentLength > 65_536)
          || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          throw new DocumentServiceError("document_service_protocol_error", false);
        }
        let body: unknown;
        try {
          const text = await response.text();
          if (Buffer.byteLength(text, "utf8") > 65_536) throw new Error("response_too_large");
          body = JSON.parse(text);
        } catch {
          if (signal.aborted) throw new DocumentServiceError("document_parse_cancelled", false);
          if (timeoutController.signal.aborted) {
            throw new DocumentServiceError("document_service_unavailable", true);
          }
          throw new DocumentServiceError("document_service_protocol_error", false);
        }
        if (!isRecord(body)
          || !exactFields(body, ["schemaVersion", "result"])
          || body.schemaVersion !== 1) {
          throw new DocumentServiceError("document_service_protocol_error", false);
        }
        try {
          return parseDocumentParseResult(body.result);
        } catch {
          throw new DocumentServiceError("document_service_protocol_error", false);
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function requestBody(target: DocumentParseTarget) {
  return {
    schemaVersion: 1,
    jobId: target.jobId,
    traceId: target.jobId,
    workspaceId: target.workspaceId,
    documentId: target.documentId,
    documentVersionId: target.documentVersionId,
    source: {
      assetId: target.sourceAssetId,
      objectKey: target.sourceObjectKey,
      sha256: target.sourceSha256,
      sizeBytes: target.sizeBytes,
      mimeType: target.mimeType,
    },
    parseConfig: target.parseConfig,
    irSchemaVersion: target.irSchemaVersion,
  };
}

function parseEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_document_service_url");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid_document_service_url");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/parse`;
  return url;
}

function exactFields(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).length === fields.length && fields.every((field) => field in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
