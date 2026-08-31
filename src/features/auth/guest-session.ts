import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { PostgresRuntime } from "@/db/postgres/runtime";

const COOKIE_NAME = "sushua.guest";
const COOKIE_VERSION = "v1";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type GuestSession = {
  learnerId: string;
  cookieValue: string;
};

type GuestSessionOptions = {
  secret: string;
  now?: () => Date;
};

type ParsedCapability = {
  learnerId: string;
  proof: string;
  body: string;
  signature: string;
};

export function createGuestSessionService(runtime: PostgresRuntime, options: GuestSessionOptions) {
  if (Buffer.byteLength(options.secret, "utf8") < 32) {
    throw new Error("guest_session_secret_too_short");
  }

  const now = options.now ?? (() => new Date());

  return {
    async ensure(cookieValue?: string): Promise<GuestSession> {
      const parsed = cookieValue ? parseCapability(cookieValue) : undefined;
      if (cookieValue && parsed && hasValidSignature(parsed, options.secret)) {
        const currentTime = now();
        const expiresAt = new Date(currentTime.getTime() + SESSION_TTL_MS);
        const tokenHash = hashProof(parsed.proof);
        const refreshed = await runtime.withTenant({ learnerId: parsed.learnerId }, async ({ query }) => {
          const result = await query<{ learner_id: string }>(
            `UPDATE guest_sessions
             SET last_seen_at = $3, expires_at = $4
             WHERE learner_id = $1
               AND token_hash = $2
               AND expires_at > $3
               AND claimed_at IS NULL
             RETURNING learner_id`,
            [parsed.learnerId, tokenHash, currentTime, expiresAt],
          );
          return result.rows[0]?.learner_id;
        });

        if (refreshed === parsed.learnerId) {
          return { learnerId: parsed.learnerId, cookieValue };
        }
      }

      return createIdentity(runtime, options.secret, now());
    },

    async getClaimProof(cookieValue: string): Promise<{ learnerId: string; tokenHash: string } | undefined> {
      const parsed = parseCapability(cookieValue);
      if (!parsed || !hasValidSignature(parsed, options.secret)) return undefined;
      const tokenHash = hashProof(parsed.proof);
      const result = await runtime.withTenant({ learnerId: parsed.learnerId }, ({ query }) =>
        query<{ learner_id: string }>(
          `SELECT learner_id
           FROM guest_sessions
           WHERE learner_id = $1 AND token_hash = $2 AND expires_at > $3`,
          [parsed.learnerId, tokenHash, now()],
        ),
      );
      return result.rows[0]?.learner_id === parsed.learnerId
        ? { learnerId: parsed.learnerId, tokenHash }
        : undefined;
    },

    serializeCookie(value: string, input: { secure: boolean }): string {
      const attributes = [
        `${COOKIE_NAME}=${value}`,
        `Max-Age=${SESSION_TTL_SECONDS}`,
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
      ];
      if (input.secure) attributes.push("Secure");
      return attributes.join("; ");
    },
  };
}

async function createIdentity(runtime: PostgresRuntime, secret: string, currentTime: Date): Promise<GuestSession> {
  const learnerId = uuidv7();
  const sessionId = uuidv7();
  const proof = randomBytes(32).toString("base64url");
  const tokenHash = hashProof(proof);
  const expiresAt = new Date(currentTime.getTime() + SESSION_TTL_MS);
  const body = `${COOKIE_VERSION}.${learnerId}.${proof}`;
  const cookieValue = `${body}.${sign(body, secret)}`;

  await runtime.withTenant({ learnerId }, async ({ query }) => {
    await query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
    await query(
      `INSERT INTO guest_sessions (id, learner_id, token_hash, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, learnerId, tokenHash, expiresAt, currentTime],
    );
  });

  return { learnerId, cookieValue };
}

function parseCapability(value: string): ParsedCapability | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const [version, learnerId, proof, signature] = parts;
  if (version !== COOKIE_VERSION || !learnerId || !proof || !signature) return undefined;
  if (!UUID_PATTERN.test(learnerId) || !PROOF_PATTERN.test(proof) || !PROOF_PATTERN.test(signature)) return undefined;
  return { learnerId, proof, signature, body: `${version}.${learnerId}.${proof}` };
}

function hasValidSignature(capability: ParsedCapability, secret: string): boolean {
  const expected = Buffer.from(sign(capability.body, secret), "base64url");
  const actual = Buffer.from(capability.signature, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function hashProof(proof: string): string {
  return createHash("sha256").update(proof).digest("hex");
}
