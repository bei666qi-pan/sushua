type UserSession = { id: string } | null;

type LearnerResolver = {
  forUser(userId: string): Promise<string>;
};

type GuestResolver = {
  ensure(cookieValue?: string): Promise<{ learnerId: string; cookieValue: string }>;
  serializeCookie(value: string, input: { secure: boolean }): string;
};

type CurrentIdentityDependencies = {
  readUser(request: Request): Promise<UserSession>;
  learners: LearnerResolver;
  guests: GuestResolver;
};

export type CurrentIdentity =
  | { learnerId: string; userId: string; kind: "user" }
  | { learnerId: string; kind: "guest"; setCookie: string };

export function createCurrentIdentityResolver(dependencies: CurrentIdentityDependencies) {
  return {
    async resolve(request: Request): Promise<CurrentIdentity> {
      const user = await dependencies.readUser(request);
      if (user) {
        return {
          learnerId: await dependencies.learners.forUser(user.id),
          userId: user.id,
          kind: "user",
        };
      }

      const guest = await dependencies.guests.ensure(readCookie(request.headers.get("cookie"), "sushua.guest"));
      return {
        learnerId: guest.learnerId,
        kind: "guest",
        setCookie: dependencies.guests.serializeCookie(guest.cookieValue, {
          secure: new URL(request.url).protocol === "https:",
        }),
      };
    },
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
