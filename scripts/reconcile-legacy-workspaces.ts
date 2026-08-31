import { Pool } from "pg";
import { reconcileLegacyWorkspaces } from "../src/features/legacy/legacy-reconcile";

async function main() {
  const snapshotPath = argument("--snapshot");
  if (!snapshotPath) throw new Error("missing_legacy_snapshot_path");
  const databaseURL = process.env.DATABASE_DIRECT_URL;
  if (!databaseURL) throw new Error("missing_config:DATABASE_DIRECT_URL");

  const pool = new Pool({ connectionString: databaseURL, max: 1 });
  try {
    const report = await reconcileLegacyWorkspaces(pool, { snapshotPath });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.summary.missing > 0 || report.summary.drifted > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "legacy_reconciliation_failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
