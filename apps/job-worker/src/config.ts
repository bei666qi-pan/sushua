import type { S3ClientConfig } from "@aws-sdk/client-s3";

type WorkerEnvironment = Readonly<Record<string, string | undefined>>;

export type JobWorkerConfig = {
  databaseUrl: string;
  redisUrl: string;
  queueName: string;
  concurrency: number;
  leaseSeconds: number;
  clamav: { host: string; port: number };
  documentService: { baseUrl: string; token: string };
  s3: { bucket: string; clientConfig: S3ClientConfig };
};

export function readJobWorkerConfig(environment: WorkerEnvironment): JobWorkerConfig {
  const databaseUrl = required(environment, "DATABASE_URL");
  const redisUrl = required(environment, "REDIS_URL");
  validateUrl(databaseUrl, ["postgres:", "postgresql:"], "invalid_worker_config:DATABASE_URL");
  validateUrl(redisUrl, ["redis:", "rediss:"], "invalid_worker_config:REDIS_URL");
  if (required(environment, "STORAGE_DRIVER") !== "s3") throw new Error("invalid_worker_config:STORAGE_DRIVER");
  if ((environment.WORKER_QUEUES?.trim() || "document") !== "document") {
    throw new Error("invalid_worker_config:WORKER_QUEUES");
  }
  const concurrency = integer(environment.WORKER_CONCURRENCY ?? "1", 1, 100, "WORKER_CONCURRENCY");
  const leaseSeconds = integer(environment.WORKER_LEASE_SECONDS ?? "300", 1, 3600, "WORKER_LEASE_SECONDS");
  const host = required(environment, "CLAMAV_HOST");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || host.length > 253) {
    throw new Error("invalid_worker_config:CLAMAV_HOST");
  }
  const port = integer(required(environment, "CLAMAV_PORT"), 1, 65_535, "CLAMAV_PORT");
  const documentServiceUrl = required(environment, "DOCUMENT_SERVICE_URL");
  validateServiceUrl(documentServiceUrl);
  const documentServiceToken = required(environment, "DOCUMENT_SERVICE_TOKEN");
  if (documentServiceToken.length < 32 || documentServiceToken.length > 512 || /[\r\n]/.test(documentServiceToken)) {
    throw new Error("invalid_worker_config:DOCUMENT_SERVICE_TOKEN");
  }
  const endpoint = environment.S3_ENDPOINT?.trim();
  if (endpoint) validateUrl(endpoint, ["http:", "https:"], "invalid_worker_config:S3_ENDPOINT");
  const accessKeyId = required(environment, "S3_ACCESS_KEY_ID");
  const secretAccessKey = required(environment, "S3_SECRET_ACCESS_KEY");
  return {
    databaseUrl,
    redisUrl,
    queueName: "sushua-document",
    concurrency,
    leaseSeconds,
    clamav: { host, port },
    documentService: { baseUrl: documentServiceUrl, token: documentServiceToken },
    s3: {
      bucket: required(environment, "S3_BUCKET"),
      clientConfig: {
        region: required(environment, "S3_REGION"),
        ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        credentials: { accessKeyId, secretAccessKey },
      },
    },
  };
}

function required(environment: WorkerEnvironment, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`missing_worker_config:${name}`);
  return value;
}

function integer(value: string, minimum: number, maximum: number, name: string) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`invalid_worker_config:${name}`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`invalid_worker_config:${name}`);
  }
  return parsed;
}

function validateUrl(value: string, protocols: string[], code: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (!protocols.includes(url.protocol)) throw new Error(code);
}

function validateServiceUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_worker_config:DOCUMENT_SERVICE_URL");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid_worker_config:DOCUMENT_SERVICE_URL");
  }
}
