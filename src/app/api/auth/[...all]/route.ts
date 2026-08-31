import { toNextJsHandler } from "better-auth/next-js";
import { getAuthServer } from "@/features/auth/server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";

function unavailable() {
  return Response.json({ error: { code: "not_found", message: "Not found", retryable: false } }, { status: 404 });
}

async function dispatch(method: "GET" | "POST", request: Request) {
  if (!isFeatureEnabled("guest_claim")) return unavailable();
  return toNextJsHandler(getAuthServer())[method](request);
}

export const GET = (request: Request) => dispatch("GET", request);
export const POST = (request: Request) => dispatch("POST", request);
