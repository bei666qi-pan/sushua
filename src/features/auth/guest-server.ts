import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createGuestSessionService } from "./guest-session";
import { createGuestClaimService } from "./guest-claim";

type GuestSessionServer = ReturnType<typeof createGuestSessionService>;
const globalGuest = globalThis as typeof globalThis & { __sushuaGuestSessions?: GuestSessionServer };
const globalClaims = globalThis as typeof globalThis & {
  __sushuaGuestClaims?: ReturnType<typeof createGuestClaimService>;
};

export function getGuestSessionServer(): GuestSessionServer {
  if (globalGuest.__sushuaGuestSessions) return globalGuest.__sushuaGuestSessions;
  const secret = process.env.GUEST_SESSION_SECRET?.trim();
  if (!secret) throw new Error("missing_guest_config:GUEST_SESSION_SECRET");
  const sessions = createGuestSessionService(getPostgresServerRuntime(), { secret });
  globalGuest.__sushuaGuestSessions = sessions;
  return sessions;
}

export function getGuestClaimServer() {
  if (globalClaims.__sushuaGuestClaims) return globalClaims.__sushuaGuestClaims;
  const claims = createGuestClaimService(getPostgresServerRuntime());
  globalClaims.__sushuaGuestClaims = claims;
  return claims;
}
