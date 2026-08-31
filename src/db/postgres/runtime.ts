import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { postgresSchema } from "./schema";

export type TenantContext = {
  learnerId: string;
  userId?: string;
  workspaceId?: string;
  shareTokenHash?: string;
};

export type TenantTransaction = {
  db: NodePgDatabase<typeof postgresSchema>;
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

export type PostgresRuntime = {
  withTenant<T>(context: TenantContext, operation: (transaction: TenantTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function createPostgresRuntime(input: {
  connectionString: string;
  maxConnections?: number;
}): PostgresRuntime {
  const pool = new Pool({
    connectionString: input.connectionString,
    max: input.maxConnections ?? 10,
  });

  return {
    async withTenant<T>(context: TenantContext, operation: (transaction: TenantTransaction) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await setTenantContext(client, context);
        const db = drizzle(client, { schema: postgresSchema });
        const transaction: TenantTransaction = {
          db,
          query: <Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) =>
            client.query<Row>(text, values),
        };
        const result = await operation(transaction);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function setTenantContext(client: PoolClient, context: TenantContext): Promise<void> {
  await client.query("SELECT set_config('app.learner_id', $1, true)", [context.learnerId]);
  await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId ?? ""]);
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [context.workspaceId ?? ""]);
  await client.query("SELECT set_config('app.share_token_hash', $1, true)", [context.shareTokenHash ?? ""]);
}
