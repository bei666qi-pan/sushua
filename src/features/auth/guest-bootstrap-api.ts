import { v7 as uuidv7 } from "uuid";
import { createGuestSessionService } from "./guest-session";

type GuestSessionService = ReturnType<typeof createGuestSessionService>;

export function createGuestBootstrapHandler(input: { sessions?: GuestSessionService; enabled: boolean }) {
  return async function bootstrap(request: Request): Promise<Response> {
    if (!input.enabled) {
      return Response.json(
        { error: { code: "not_found", message: "Not found", retryable: false }, request_id: uuidv7() },
        { status: 404 },
      );
    }

    if (!input.sessions) throw new Error("guest_session_service_unavailable");

    const cookieValue = readCookie(request.headers.get("cookie"), "sushua.guest");
    const session = await input.sessions.ensure(cookieValue);
    const response = Response.json({
      data: { learner_id: session.learnerId },
      meta: { request_id: uuidv7(), schema_version: "sushua.api.v1" },
    });
    response.headers.append(
      "set-cookie",
      input.sessions.serializeCookie(session.cookieValue, { secure: new URL(request.url).protocol === "https:" }),
    );
    return response;
  };
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}
