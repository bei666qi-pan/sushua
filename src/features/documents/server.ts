import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createDocumentModule } from "./document-module";

type DocumentServer = ReturnType<typeof createDocumentModule>;
const globalDocuments = globalThis as typeof globalThis & { __sushuaDocuments?: DocumentServer };

export function getDocumentServer(): DocumentServer {
  if (globalDocuments.__sushuaDocuments) return globalDocuments.__sushuaDocuments;
  const documents = createDocumentModule(getPostgresServerRuntime());
  globalDocuments.__sushuaDocuments = documents;
  return documents;
}
