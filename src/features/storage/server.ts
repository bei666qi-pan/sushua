import { createS3StorageAdapter } from "./s3-storage-adapter";
import type { StorageAdapter } from "./storage";

type StorageEnvironment = Readonly<Record<string, string | undefined>>;
const globalStorage = globalThis as typeof globalThis & { __sushuaStorage?: StorageAdapter };

export function createStorageFromEnvironment(environment: StorageEnvironment): StorageAdapter {
  for (const name of ["STORAGE_DRIVER", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
    if (!environment[name]?.trim()) throw new Error(`missing_storage_config:${name}`);
  }
  if (environment.STORAGE_DRIVER !== "s3") throw new Error("invalid_storage_config:STORAGE_DRIVER");
  const endpoint = environment.S3_ENDPOINT?.trim();
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("invalid_storage_config:S3_ENDPOINT");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("invalid_storage_config:S3_ENDPOINT");
  }
  return createS3StorageAdapter({
    bucket: environment.S3_BUCKET!.trim(),
    clientConfig: {
      region: environment.S3_REGION!.trim(),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: environment.S3_ACCESS_KEY_ID!.trim(),
        secretAccessKey: environment.S3_SECRET_ACCESS_KEY!.trim(),
      },
    },
  });
}

export function getStorageServer(): StorageAdapter {
  if (globalStorage.__sushuaStorage) return globalStorage.__sushuaStorage;
  const storage = createStorageFromEnvironment(process.env);
  globalStorage.__sushuaStorage = storage;
  return storage;
}
