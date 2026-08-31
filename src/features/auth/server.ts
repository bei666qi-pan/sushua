import nodemailer from "nodemailer";
import { Pool } from "pg";
import { createOTPEmailDelivery } from "./email";
import { createAuthRuntime } from "./runtime";
import { readAuthServerConfig } from "./server-config";

type AuthServer = ReturnType<typeof createAuthRuntime>;
const globalAuth = globalThis as typeof globalThis & { __sushuaAuth?: AuthServer };

export function getAuthServer(): AuthServer {
  if (globalAuth.__sushuaAuth) return globalAuth.__sushuaAuth;
  const config = readAuthServerConfig();
  const pool = new Pool({ connectionString: config.databaseURL, max: 10 });
  const transport = nodemailer.createTransport({ url: config.smtpURL, pool: true, maxConnections: 3 });
  const auth = createAuthRuntime({
    pool,
    baseURL: config.baseURL,
    secret: config.secret,
    sendVerificationOTP: createOTPEmailDelivery({ from: config.emailFrom, transport }),
  });
  globalAuth.__sushuaAuth = auth;
  return auth;
}
