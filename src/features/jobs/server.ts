import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createJobModule } from "./job-module";

type JobServer = ReturnType<typeof createJobModule>;
const globalJobs = globalThis as typeof globalThis & { __sushuaJobs?: JobServer };

export function getJobServer(): JobServer {
  if (globalJobs.__sushuaJobs) return globalJobs.__sushuaJobs;
  const jobs = createJobModule(getPostgresServerRuntime());
  globalJobs.__sushuaJobs = jobs;
  return jobs;
}
