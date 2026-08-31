export type WorkspaceListItem = {
  id: string;
  slug: string;
  title: string;
  visibility: "private" | "link" | "public";
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkspaceApiError";
  }
}

export function createWorkspaceClient(fetcher: FetchLike = fetch) {
  return {
    async list(): Promise<WorkspaceListItem[]> {
      const envelope = await request<{ items: WorkspaceListItem[] }>(fetcher, "/api/v1/workspaces", { method: "GET" });
      return envelope.items;
    },

    create(
      input: { title: string; visibility: WorkspaceListItem["visibility"] },
      idempotencyKey = crypto.randomUUID(),
    ): Promise<WorkspaceListItem> {
      return request(fetcher, "/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(input),
      });
    },

    claim(workspaceId: string, idempotencyKey = crypto.randomUUID()): Promise<{ status: string; learner_id: string }> {
      return request(fetcher, `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/claim`, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
      });
    },
  };
}

async function request<T>(fetcher: FetchLike, url: string, init: RequestInit): Promise<T> {
  const response = await fetcher(url, init);
  const body = await response.json().catch(() => null) as {
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  if (!response.ok || !body?.data) {
    throw new WorkspaceApiError(
      body?.error?.message || "请求失败，请稍后重试",
      body?.error?.code || "request_failed",
      response.status,
      body?.error?.details,
    );
  }
  return body.data;
}
