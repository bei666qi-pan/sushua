import { drizzle } from "drizzle-orm/node-postgres";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Pool } from "pg";
import { postgresSchema } from "@/db/postgres/schema";
import { createAuthPolicy } from "./auth-policy";
import { withHashedSessionTokens } from "./session-token-adapter";

type AuthRuntimeInput = {
  pool: Pool;
  baseURL: string;
  secret: string;
  sendVerificationOTP: (data: {
    email: string;
    otp: string;
    type: "sign-in" | "email-verification" | "forget-password" | "change-email";
  }) => Promise<void>;
};

export function createAuthRuntime(input: AuthRuntimeInput) {
  const database = drizzle(input.pool, { schema: postgresSchema });
  const adapter = withHashedSessionTokens(drizzleAdapter(database, {
    provider: "pg",
    schema: postgresSchema,
  }));

  return betterAuth(createAuthPolicy({
    baseURL: input.baseURL,
    secret: input.secret,
    database: adapter,
    sendVerificationOTP: input.sendVerificationOTP,
  }));
}
