import path from "node:path";
import { createLegacySnapshot } from "../src/features/legacy/legacy-snapshot";

async function main() {
  const destination = argument("--snapshot");
  if (!destination) {
    throw new Error("usage: npm run legacy:snapshot -- --snapshot <immutable-backup-path> [--source <sushua.db>]");
  }
  const source = argument("--source") ?? path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "sushua.db");
  const report = await createLegacySnapshot({ sourcePath: source, snapshotPath: destination });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "legacy_snapshot_failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
