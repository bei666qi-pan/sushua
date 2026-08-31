import { Pool } from "pg";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";

const connectionString = process.env.DATABASE_DIRECT_URL;
if (!connectionString) {
  throw new Error("DATABASE_DIRECT_URL is required for migrations");
}

const pool = new Pool({ connectionString, max: 1 });

async function main(): Promise<void> {
  try {
    await applyPostgresMigrations(pool);
    console.log("PostgreSQL migrations applied successfully");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
