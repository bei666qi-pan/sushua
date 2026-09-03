import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const migration = await readFile(
    path.join(process.cwd(), "src/db/postgres/migrations/0020_document_ir_pages_blocks.sql"),
    "utf8",
  );
  console.log("Document IR migration contract");
  assert.ok(
    migration.includes("'(^|/)\\.\\.?(/|$)'"),
    "tenant object-key checks must use the proven PostgreSQL dot-segment regex",
  );
  console.log("  ✓ tenant object-key constraints use PostgreSQL path-segment regexes");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
