import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createDocumentSourceModule } from "./document-source-module";

type DocumentSourceServer = ReturnType<typeof createDocumentSourceModule>;
const globalSources = globalThis as typeof globalThis & { __sushuaDocumentSource?: DocumentSourceServer };

export function getDocumentSourceServer(): DocumentSourceServer {
  if (globalSources.__sushuaDocumentSource) return globalSources.__sushuaDocumentSource;
  const sources = createDocumentSourceModule(getPostgresServerRuntime());
  globalSources.__sushuaDocumentSource = sources;
  return sources;
}
