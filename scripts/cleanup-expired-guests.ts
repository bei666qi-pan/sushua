import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createGuestRetentionService } from "../src/features/auth/guest-retention";

async function main() {
  if (!process.argv.includes("--commit")) throw new Error("missing_guest_cleanup_commit");
  const databaseURL = process.env.DATABASE_URL;
  if (!databaseURL) throw new Error("missing_config:DATABASE_URL");

  const beforeValue = argument("--before");
  const before = beforeValue ? new Date(beforeValue) : new Date();
  const limitValue = argument("--limit");
  const limit = limitValue === undefined ? 100 : Number(limitValue);
  const runtime = createPostgresRuntime({ connectionString: databaseURL, maxConnections: 1 });
  try {
    const result = await createGuestRetentionService(runtime).purgeExpired({ before, limit });
    process.stdout.write(`${JSON.stringify({ before: before.toISOString(), limit, ...result }, null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "guest_cleanup_failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
