import { Pool } from "pg";
import { backfillLegacyWorkspaces } from "../src/features/legacy/legacy-backfill";

async function main() {
  const snapshotPath = argument("--snapshot");
  if (!snapshotPath) throw new Error("missing_legacy_snapshot_path");
  const commit = process.argv.includes("--commit");
  const databaseURL = commit ? process.env.DATABASE_DIRECT_URL : process.env.LEGACY_DRY_RUN_DATABASE_URL;
  if (!databaseURL) {
    throw new Error(commit ? "missing_config:DATABASE_DIRECT_URL" : "missing_config:LEGACY_DRY_RUN_DATABASE_URL");
  }
  const pool = new Pool({ connectionString: databaseURL, max: 1 });
  try {
    const report = await backfillLegacyWorkspaces(pool, { snapshotPath, dryRun: !commit });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.items.some((item) => item.status === "conflict")) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "legacy_backfill_failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
