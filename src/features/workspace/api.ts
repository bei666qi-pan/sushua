import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { CurrentIdentity } from "@/features/auth/current-identity";
import { createWorkspaceModule, type WorkspaceVisibility } from "./module";

type WorkspaceModule = ReturnType<typeof createWorkspaceModule>;
type IdentityResolver = { resolve(request: Request): Promise<CurrentIdentity> };

export function createWorkspaceCollectionHandlers(input: {
  enabled: boolean;
  identity?: IdentityResolver;
  workspaces?: WorkspaceModule;
}) {
  return {
    GET: (request: Request) => handleList(input, request),
    POST: (request: Request) => handleCreate(input, request),
  };
}

async function handleList(input: HandlerDependencies, request: Request): Promise<Response> {
  if (!input.enabled) return notFound();
  const { identity, workspaces } = requireDependencies(input);
  const current = await identity.resolve(request);
  const items = await workspaces.listVisibleWorkspaces(identityContext(current));
  return withIdentityCookie(Response.json({
    data: { items },
    meta: { request_id: uuidv7(), schema_version: "sushua.api.v1", next_cursor: null },
  }), current);
}

async function handleCreate(input: HandlerDependencies, request: Request): Promise<Response> {
  if (!input.enabled) return notFound();
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
  const parsed = parseCreateBody(body);
  if ("error" in parsed) return apiError(400, parsed.error, parsed.message, false);

  const { identity, workspaces } = requireDependencies(input);
  const current = await identity.resolve(request);
  const id = uuidv7();
  const requestHash = createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
  const result = await workspaces.createWorkspace(identityContext(current), {
    id,
    slug: createSlug(parsed.value.title, id),
    ...parsed.value,
    idempotencyKey,
    requestHash,
  });
  if (result.status === "conflict") {
    return withIdentityCookie(apiError(409, "idempotency_conflict", "该幂等键已用于不同请求", false), current);
  }

  return withIdentityCookie(Response.json({
    data: result.workspace,
    meta: {
      request_id: uuidv7(),
      schema_version: "sushua.api.v1",
      idempotent_replay: result.status === "replayed",
    },
  }, { status: result.status === "created" ? 201 : 200 }), current);
}

type HandlerDependencies = Parameters<typeof createWorkspaceCollectionHandlers>[0];

function requireDependencies(input: HandlerDependencies) {
  if (!input.identity || !input.workspaces) throw new Error("workspace_api_dependencies_unavailable");
  return { identity: input.identity, workspaces: input.workspaces };
}

function parseCreateBody(body: unknown):
  | { value: { title: string; visibility: WorkspaceVisibility } }
  | { error: string; message: string } {
  if (!body || typeof body !== "object") return { error: "invalid_body", message: "请求正文无效" };
  const candidate = body as Record<string, unknown>;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!title || title.length > 80) return { error: "invalid_title", message: "资料库名称须为 1–80 个字符" };
  const visibility = candidate.visibility ?? "private";
  if (visibility !== "private" && visibility !== "link" && visibility !== "public") {
    return { error: "invalid_visibility", message: "可见性无效" };
  }
  return { value: { title, visibility } };
}

function identityContext(identity: CurrentIdentity) {
  return { learnerId: identity.learnerId, ...(identity.kind === "user" ? { userId: identity.userId } : {}) };
}

function createSlug(title: string, id: string) {
  const stem = title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return `${stem || "workspace"}-${id.slice(0, 8)}`;
}

function withIdentityCookie(response: Response, identity: CurrentIdentity) {
  if (identity.kind === "guest") response.headers.append("set-cookie", identity.setCookie);
  return response;
}

function notFound() {
  return apiError(404, "not_found", "Not found", false);
}

function apiError(status: number, code: string, message: string, retryable: boolean) {
  return Response.json({ error: { code, message, retryable }, request_id: uuidv7() }, { status });
}
