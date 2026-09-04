import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createDocumentRevisionModule } from "./document-revision-module";

type DocumentRevisionServer = ReturnType<typeof createDocumentRevisionModule>;
const globalRevisions = globalThis as typeof globalThis & { __sushuaDocumentRevisions?: DocumentRevisionServer };

export function getDocumentRevisionServer(): DocumentRevisionServer {
  if (globalRevisions.__sushuaDocumentRevisions) return globalRevisions.__sushuaDocumentRevisions;
  const revisions = createDocumentRevisionModule(getPostgresServerRuntime());
  globalRevisions.__sushuaDocumentRevisions = revisions;
  return revisions;
}
