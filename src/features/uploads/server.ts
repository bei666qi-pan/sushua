import { getDocumentServer } from "@/features/documents/server";
import { getStorageServer } from "@/features/storage/server";
import { createUploadModule } from "./upload-module";

type UploadServer = ReturnType<typeof createUploadModule>;
const globalUploads = globalThis as typeof globalThis & { __sushuaUploads?: UploadServer };

export function getUploadServer(): UploadServer {
  if (globalUploads.__sushuaUploads) return globalUploads.__sushuaUploads;
  const uploads = createUploadModule({ documents: getDocumentServer(), storage: getStorageServer() });
  globalUploads.__sushuaUploads = uploads;
  return uploads;
}
