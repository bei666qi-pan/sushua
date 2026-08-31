import { createPostgresRuntime, type PostgresRuntime } from "./runtime";

const globalPostgres = globalThis as typeof globalThis & { __sushuaPostgresRuntime?: PostgresRuntime };

export function getPostgresServerRuntime(): PostgresRuntime {
  if (globalPostgres.__sushuaPostgresRuntime) return globalPostgres.__sushuaPostgresRuntime;
  const databaseURL = process.env.DATABASE_URL?.trim();
  if (!databaseURL) throw new Error("missing_postgres_config:DATABASE_URL");
  const runtime = createPostgresRuntime({ connectionString: databaseURL, maxConnections: 10 });
  globalPostgres.__sushuaPostgresRuntime = runtime;
  return runtime;
}
