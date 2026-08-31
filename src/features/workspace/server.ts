import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createWorkspaceModule } from "./module";

type WorkspaceServer = ReturnType<typeof createWorkspaceModule>;
const globalWorkspace = globalThis as typeof globalThis & { __sushuaWorkspace?: WorkspaceServer };

export function getWorkspaceServer(): WorkspaceServer {
  if (globalWorkspace.__sushuaWorkspace) return globalWorkspace.__sushuaWorkspace;
  const workspace = createWorkspaceModule(getPostgresServerRuntime());
  globalWorkspace.__sushuaWorkspace = workspace;
  return workspace;
}
