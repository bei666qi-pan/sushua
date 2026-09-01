import { readJobWorkerConfig } from "./config";
import { createJobWorkerRuntime } from "./runtime";

const runtime = createJobWorkerRuntime(readJobWorkerConfig(process.env), () => {
  console.error("job_worker_runtime_error");
});

await runtime.waitUntilReady();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.close();
}

process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
