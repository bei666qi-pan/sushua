import { createBullMqJobDispatcher } from "./bullmq-job-dispatcher";
import type { JobDispatcher } from "./job-dispatcher";

type DispatcherEnvironment = Readonly<Record<string, string | undefined>>;
const globalDispatcher = globalThis as typeof globalThis & { __sushuaJobDispatcher?: JobDispatcher };

export function createJobDispatcherFromEnvironment(
  environment: DispatcherEnvironment,
  createDispatcher: typeof createBullMqJobDispatcher = createBullMqJobDispatcher,
): JobDispatcher {
  const redisUrl = environment.REDIS_URL?.trim();
  if (!redisUrl) throw new Error("missing_job_dispatch_config:REDIS_URL");
  return createDispatcher({ queueName: "sushua-document", redisUrl });
}

export function getJobDispatcherServer(): JobDispatcher {
  if (globalDispatcher.__sushuaJobDispatcher) return globalDispatcher.__sushuaJobDispatcher;
  const dispatcher = createJobDispatcherFromEnvironment(process.env);
  globalDispatcher.__sushuaJobDispatcher = dispatcher;
  return dispatcher;
}
