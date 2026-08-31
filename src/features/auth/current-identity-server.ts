import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createCurrentIdentityResolver } from "./current-identity";
import { getAuthServer } from "./server";
import { getGuestSessionServer } from "./guest-server";
import { createLearnerResolutionService } from "./learner-resolution";

type CurrentIdentityServer = ReturnType<typeof createCurrentIdentityResolver>;
const globalIdentity = globalThis as typeof globalThis & { __sushuaCurrentIdentity?: CurrentIdentityServer };

export function getCurrentIdentityServer(): CurrentIdentityServer {
  if (globalIdentity.__sushuaCurrentIdentity) return globalIdentity.__sushuaCurrentIdentity;
  const identity = createCurrentIdentityResolver({
    readUser: async (request) => {
      const session = await getAuthServer().api.getSession({ headers: request.headers });
      return session?.user ? { id: session.user.id } : null;
    },
    learners: createLearnerResolutionService(getPostgresServerRuntime()),
    guests: getGuestSessionServer(),
  });
  globalIdentity.__sushuaCurrentIdentity = identity;
  return identity;
}
