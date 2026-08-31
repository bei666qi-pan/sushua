import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export async function applyPostgresMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const directory = path.join(process.cwd(), "src/db/postgres/migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  for (const name of names) {
    const sql = await readFile(path.join(directory, name), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query<{ sha256: string }>(
      "SELECT sha256 FROM schema_migrations WHERE name = $1",
      [name],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].sha256 !== sha256) {
        throw new Error(`Applied migration was modified: ${name}`);
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha256]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
