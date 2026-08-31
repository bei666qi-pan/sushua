import type { BetterAuthOptions } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { v7 as uuidv7 } from "uuid";

type EmailOTPDelivery = (data: {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}) => Promise<void>;

type AuthPolicyInput = {
  baseURL: string;
  secret: string;
  database: NonNullable<BetterAuthOptions["database"]>;
  sendVerificationOTP: EmailOTPDelivery;
};

export const DISABLED_AUTH_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/change-password",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
] as const;

export function createAuthPolicy(input: AuthPolicyInput) {
  return {
    appName: "速刷",
    baseURL: input.baseURL,
    secret: input.secret,
    database: input.database,
    emailAndPassword: { enabled: false },
    socialProviders: {},
    plugins: [
      emailOTP({
        sendVerificationOTP: input.sendVerificationOTP,
        storeOTP: "hashed",
        expiresIn: 5 * 60,
        allowedAttempts: 3,
        rateLimit: { window: 60, max: 3 },
        resendStrategy: "rotate",
        changeEmail: { enabled: false },
      }),
    ],
    user: { modelName: "users" },
    session: { modelName: "authSessions" },
    account: {
      modelName: "authAccounts",
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    verification: { modelName: "authVerifications" },
    disabledPaths: [...DISABLED_AUTH_PATHS],
    advanced: {
      cookiePrefix: "sushua",
      database: {
        generateId: (context) => {
          void context;
          return uuidv7();
        },
      },
    },
  } satisfies BetterAuthOptions;
}
