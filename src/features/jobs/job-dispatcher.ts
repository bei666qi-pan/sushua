import type { JobEnvelope } from "@sushua/job-contracts";

export interface JobDispatcher {
  dispatch(envelope: JobEnvelope): Promise<void>;
  close(): Promise<void>;
}
