import { v7 as uuidv7 } from "uuid";
import type { CurrentIdentity } from "@/features/auth/current-identity";
import { createJobModule, type JobSnapshot } from "./job-module";

type JobModule = ReturnType<typeof createJobModule>;
type IdentityResolver = { resolve(request: Request): Promise<CurrentIdentity> };
type HandlerDependencies = {
  enabled: boolean;
  identity?: IdentityResolver;
  jobs?: JobModule;
  stream?: Partial<JobStreamOptions>;
};
type JobStreamOptions = { pollIntervalMs: number; maxDurationMs: number; heartbeatMs: number };

const DEFAULT_STREAM_OPTIONS: JobStreamOptions = {
  pollIntervalMs: 1_000,
  maxDurationMs: 25_000,
  heartbeatMs: 15_000,
};
const TERMINAL_STATES = new Set(["succeeded", "partially_succeeded", "failed", "dead_lettered", "cancelled"]);

export function createJobHandlers(input: HandlerDependencies) {
  return {
    GET: (request: Request, jobId: string) => handleRead(input, request, jobId),
    STREAM: (request: Request, jobId: string) => handleStream(input, request, jobId),
    CANCEL: (request: Request, jobId: string) => handleCancel(input, request, jobId),
  };
}

async function handleRead(input: HandlerDependencies, request: Request, jobId: string): Promise<Response> {
  if (!input.enabled) return apiError(404, "not_found", "Not found", false);
  const { identity, jobs } = requireDependencies(input);
  const current = await identity.resolve(request);
  try {
    const job = await jobs.read(identityContext(current), jobId);
    if (!job) return withIdentityCookie(apiError(404, "job_not_found", "Job not found", false), current);
    return withIdentityCookie(success(job), current);
  } catch (error) {
    return withIdentityCookie(jobError(error), current);
  }
}

async function handleStream(input: HandlerDependencies, request: Request, jobId: string): Promise<Response> {
  if (!input.enabled) return apiError(404, "not_found", "Not found", false);
  const { identity, jobs } = requireDependencies(input);
  const current = await identity.resolve(request);
  const actor = identityContext(current);
  try {
    const initial = await jobs.read(actor, jobId);
    if (!initial) return withIdentityCookie(apiError(404, "job_not_found", "Job not found", false), current);
    const response = createJobStreamResponse({
      initial,
      read: () => jobs.read(actor, jobId),
      signal: request.signal,
      options: streamOptions(input.stream),
    });
    return withIdentityCookie(response, current);
  } catch (error) {
    return withIdentityCookie(jobError(error), current);
  }
}

async function handleCancel(input: HandlerDependencies, request: Request, jobId: string): Promise<Response> {
  if (!input.enabled) return apiError(404, "not_found", "Not found", false);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return apiError(400, "idempotency_key_required", "需要有效的 Idempotency-Key", false);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "请求格式错误", false);
  }
  const reason = parseCancelReason(body);
  if (!reason) return apiError(400, "invalid_cancel_reason", "取消原因须为 1–120 个字符", false);

  const { identity, jobs } = requireDependencies(input);
  const current = await identity.resolve(request);
  try {
    const job = await jobs.requestCancel(identityContext(current), jobId, reason);
    return withIdentityCookie(success(job), current);
  } catch (error) {
    return withIdentityCookie(jobError(error), current);
  }
}

function requireDependencies(input: HandlerDependencies) {
  if (!input.identity || !input.jobs) throw new Error("job_api_dependencies_unavailable");
  return { identity: input.identity, jobs: input.jobs };
}

function parseCancelReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => key !== "reason")) return undefined;
  const reason = typeof candidate.reason === "string" ? candidate.reason.trim() : "";
  return reason && reason.length <= 120 ? reason : undefined;
}

function identityContext(identity: CurrentIdentity) {
  return {
    learnerId: identity.learnerId,
    ...(identity.kind === "user" ? { userId: identity.userId } : {}),
  };
}

function success(job: JobSnapshot) {
  return Response.json({
    data: jobData(job),
    meta: { request_id: uuidv7(), schema_version: "sushua.api.v1" },
  });
}

function jobData(job: JobSnapshot) {
  return {
    id: job.id,
    workspace_id: job.workspaceId,
    resource_id: job.resourceId,
    type: job.type,
    state: job.state,
    progress: {
      phase: job.progress.phase,
      percent: job.progress.percent,
      ...(job.progress.current === undefined ? {} : { current: job.progress.current }),
      ...(job.progress.total === undefined ? {} : { total: job.progress.total }),
      ...(job.progress.messageCode === undefined ? {} : { message_code: job.progress.messageCode }),
      updated_at: job.progress.updatedAt,
    },
    ...(job.checkpoint === undefined ? {} : { checkpoint: job.checkpoint }),
    attempt: job.attempt,
    max_attempts: job.maxAttempts,
    ...(job.errorCode === undefined ? {} : { error_code: job.errorCode }),
    run_after: job.runAfter,
  };
}

function createJobStreamResponse(input: {
  initial: JobSnapshot;
  read(): Promise<JobSnapshot | undefined>;
  signal: AbortSignal;
  options: JobStreamOptions;
}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void pumpJobStream(input, controller, encoder, () => cancelled);
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

async function pumpJobStream(
  input: { initial: JobSnapshot; read(): Promise<JobSnapshot | undefined>; signal: AbortSignal; options: JobStreamOptions },
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  isCancelled: () => boolean,
) {
  const startedAt = Date.now();
  let heartbeatAt = startedAt;
  let snapshot: JobSnapshot | undefined = input.initial;
  let previous = "";
  try {
    controller.enqueue(encoder.encode("retry: 1000\n\n"));
    while (!input.signal.aborted && !isCancelled() && snapshot) {
      const data = JSON.stringify(jobData(snapshot));
      if (data !== previous) {
        controller.enqueue(encoder.encode(`id: ${snapshot.attempt}:${snapshot.progress.updatedAt}\nevent: job\ndata: ${data}\n\n`));
        previous = data;
      }
      if (TERMINAL_STATES.has(snapshot.state)) {
        controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ state: snapshot.state })}\n\n`));
        controller.close();
        return;
      }
      const now = Date.now();
      if (now - startedAt >= input.options.maxDurationMs) {
        controller.enqueue(encoder.encode("event: reconnect\ndata: {\"retry_after_ms\":1000}\n\n"));
        controller.close();
        return;
      }
      if (now - heartbeatAt >= input.options.heartbeatMs) {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        heartbeatAt = now;
      }
      await wait(input.options.pollIntervalMs, input.signal);
      if (input.signal.aborted || isCancelled()) break;
      snapshot = await input.read();
    }
    if (!isCancelled()) controller.close();
  } catch {
    if (!isCancelled()) {
      controller.enqueue(encoder.encode("event: error\ndata: {\"code\":\"job_stream_unavailable\",\"retryable\":true}\n\n"));
      controller.close();
    }
  }
}

function streamOptions(input: Partial<JobStreamOptions> | undefined): JobStreamOptions {
  const options = { ...DEFAULT_STREAM_OPTIONS, ...input };
  if (options.pollIntervalMs < 1 || options.maxDurationMs < 1 || options.heartbeatMs < 1) {
    throw new Error("invalid_job_stream_options");
  }
  return options;
}

function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function withIdentityCookie(response: Response, identity: CurrentIdentity) {
  if (identity.kind === "guest") response.headers.append("set-cookie", identity.setCookie);
  return response;
}

function jobError(error: unknown) {
  const code = error instanceof Error ? error.message : "job_request_failed";
  if (code === "job_not_found") return apiError(404, code, "Job not found", false);
  if (code === "invalid_job_id") return apiError(400, code, "Job id is invalid", false);
  if (code === "invalid_job_cancel_reason") return apiError(400, code, "Cancel reason is invalid", false);
  if (code === "invalid_job_transition") return apiError(409, code, "Job can no longer be cancelled", false);
  return apiError(500, "job_request_failed", "Job request failed", true);
}

function apiError(status: number, code: string, message: string, retryable: boolean) {
  return Response.json({ error: { code, message, retryable }, request_id: uuidv7() }, { status });
}
