import assert from "node:assert/strict";

import { postgresSchema } from "../src/db/postgres/schema";

async function main() {
  console.log("Document IR Drizzle schema contract");
  const schema = postgresSchema as Record<string, unknown>;
  assert.ok(schema.pages, "Page relation must be exported for Document IR callers");
  assert.ok(schema.blocks, "Block relation must be exported for Document IR callers");
  console.log("  ✓ Document IR exposes Page and Block relations");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
