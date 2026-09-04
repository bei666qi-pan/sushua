import { getPostgresServerRuntime } from "@/db/postgres/server";
import { getStorageServer } from "@/features/storage/server";
import { createBlockSourceModule } from "./block-source-module";

type BlockSourceServer = ReturnType<typeof createBlockSourceModule>;
const globalSources = globalThis as typeof globalThis & { __sushuaBlockSource?: BlockSourceServer };

export function getBlockSourceServer(): BlockSourceServer {
  if (globalSources.__sushuaBlockSource) return globalSources.__sushuaBlockSource;
  const sources = createBlockSourceModule(getPostgresServerRuntime(), getStorageServer());
  globalSources.__sushuaBlockSource = sources;
  return sources;
}
