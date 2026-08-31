type AuthEnvironment = Readonly<Record<string, string | undefined>>;

const REQUIRED_KEYS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "SMTP_URL",
  "AUTH_EMAIL_FROM",
] as const;

export function readAuthServerConfig(environment: AuthEnvironment = process.env) {
  for (const key of REQUIRED_KEYS) {
    if (!environment[key]?.trim()) throw new Error(`missing_auth_config:${key}`);
  }
  const secret = environment.BETTER_AUTH_SECRET!;
  if (secret.length < 32) throw new Error("invalid_auth_secret");

  const baseURL = parseURL(environment.BETTER_AUTH_URL!, ["http:", "https:"], "invalid_auth_url");
  const smtpURL = parseURL(environment.SMTP_URL!, ["smtp:", "smtps:"], "invalid_smtp_url");

  return {
    databaseURL: environment.DATABASE_URL!,
    secret,
    baseURL: baseURL.toString().replace(/\/$/, ""),
    smtpURL: smtpURL.toString(),
    emailFrom: environment.AUTH_EMAIL_FROM!,
  };
}

function parseURL(value: string, protocols: string[], errorCode: string) {
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) throw new Error(errorCode);
    return parsed;
  } catch {
    throw new Error(errorCode);
  }
}
