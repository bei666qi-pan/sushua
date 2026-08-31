type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type LegacyClaimResult = {
  status: "claimed" | "already_claimed";
  learner_id: string;
  workspace_id: string;
};

export class LegacyBankClaimError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LegacyBankClaimError";
  }
}

export function createLegacyBankClient(fetcher: FetchLike = fetch) {
  return {
    async claim(slug: string, ownerKey: string, idempotencyKey = crypto.randomUUID()): Promise<LegacyClaimResult> {
      const response = await fetcher(`/api/v1/legacy/banks/${encodeURIComponent(slug)}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({ owner_key: ownerKey }),
      });
      const body = await response.json().catch(() => null) as {
        data?: LegacyClaimResult;
        error?: { code?: string; message?: string };
      } | null;
      if (!response.ok || !body?.data) {
        throw new LegacyBankClaimError(
          body?.error?.message || "认领失败，请稍后重试",
          body?.error?.code || "request_failed",
          response.status,
        );
      }
      return body.data;
    },
  };
}

export function legacyClaimReturnPath(slug: string) {
  return `/b/${encodeURIComponent(slug)}?claim=1`;
}
