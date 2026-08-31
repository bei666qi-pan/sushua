import { and, asc, eq, isNull } from "drizzle-orm";
import type { PostgresRuntime, TenantContext } from "@/db/postgres/runtime";
import { guestSessions, learners, workspaceMembers, workspaces } from "@/db/postgres/schema";

export type WorkspaceVisibility = "private" | "link" | "public";

type WorkspaceRecord = {
  id: string;
  slug: string;
  title: string;
  visibility: WorkspaceVisibility;
};

export type WorkspaceCreateResult =
  | { status: "created" | "replayed"; workspace: WorkspaceRecord }
  | { status: "conflict" };

export function createWorkspaceModule(runtime: PostgresRuntime) {
  return {
    async createGuestIdentity(input: {
      learnerId: string;
      guestSessionId: string;
      tokenHash: string;
      expiresAt: Date;
    }): Promise<void> {
      await runtime.withTenant({ learnerId: input.learnerId }, async ({ db }) => {
        await db.insert(learners).values({ id: input.learnerId });
        await db.insert(guestSessions).values({
          id: input.guestSessionId,
          learnerId: input.learnerId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        });
      });
    },

    async createWorkspace(
      context: TenantContext,
      input: {
        id: string;
        slug: string;
        title: string;
        visibility: WorkspaceVisibility;
        idempotencyKey?: string;
        requestHash?: string;
      },
    ): Promise<WorkspaceCreateResult> {
      return runtime.withTenant(context, async ({ db, query }) => {
        if (input.idempotencyKey && input.requestHash) {
          const existing = await findByIdempotencyKey(query, context.learnerId, input.idempotencyKey);
          if (existing) {
            return existing.create_request_hash === input.requestHash
              ? { status: "replayed", workspace: toWorkspaceRecord(existing) }
              : { status: "conflict" };
          }
        }

        const inserted = await query<WorkspaceRow>(
          `INSERT INTO workspaces (
             id, slug, title, visibility, created_by_learner_id, idempotency_key, create_request_hash
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (created_by_learner_id, idempotency_key)
             WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id, slug, title, visibility, create_request_hash`,
          [
            input.id,
            input.slug,
            input.title,
            input.visibility,
            context.learnerId,
            input.idempotencyKey ?? null,
            input.requestHash ?? null,
          ],
        );
        const created = inserted.rows[0];
        if (created) {
          await db.insert(workspaceMembers).values({
            workspaceId: input.id,
            learnerId: context.learnerId,
            role: "owner",
          });
          return { status: "created", workspace: toWorkspaceRecord(created) };
        }

        if (!input.idempotencyKey || !input.requestHash) throw new Error("workspace_create_failed");
        const replayed = await findByIdempotencyKey(query, context.learnerId, input.idempotencyKey);
        if (!replayed) throw new Error("workspace_idempotency_resolution_failed");
        return replayed.create_request_hash === input.requestHash
          ? { status: "replayed", workspace: toWorkspaceRecord(replayed) }
          : { status: "conflict" };
      });
    },

    async listVisibleWorkspaces(context: TenantContext) {
      return runtime.withTenant(context, ({ db }) =>
        db
          .select({ id: workspaces.id, slug: workspaces.slug, title: workspaces.title, visibility: workspaces.visibility })
          .from(workspaces)
          .where(isNull(workspaces.deletedAt))
          .orderBy(asc(workspaces.createdAt), asc(workspaces.id)),
      );
    },

    async getOwnedWorkspace(context: TenantContext & { workspaceId: string }): Promise<WorkspaceRecord | undefined> {
      const rows = await runtime.withTenant(context, ({ db }) =>
        db
          .select({ id: workspaces.id, slug: workspaces.slug, title: workspaces.title, visibility: workspaces.visibility })
          .from(workspaces)
          .where(and(
            eq(workspaces.id, context.workspaceId),
            eq(workspaces.createdByLearnerId, context.learnerId),
            isNull(workspaces.deletedAt),
          )),
      );
      return rows[0];
    },

    async updateVisibility(context: TenantContext & { workspaceId: string }, visibility: WorkspaceVisibility) {
      return runtime.withTenant(context, ({ db }) =>
        db
          .update(workspaces)
          .set({ visibility, updatedAt: new Date() })
          .where(and(eq(workspaces.id, context.workspaceId), isNull(workspaces.deletedAt))),
      );
    },
  };
}

type WorkspaceRow = {
  id: string;
  slug: string;
  title: string;
  visibility: WorkspaceVisibility;
  create_request_hash: string | null;
};

async function findByIdempotencyKey(
  query: Parameters<Parameters<PostgresRuntime["withTenant"]>[1]>[0]["query"],
  learnerId: string,
  key: string,
): Promise<WorkspaceRow | undefined> {
  const result = await query<WorkspaceRow>(
    `SELECT id, slug, title, visibility, create_request_hash
     FROM workspaces
     WHERE created_by_learner_id = $1 AND idempotency_key = $2 AND deleted_at IS NULL`,
    [learnerId, key],
  );
  return result.rows[0];
}

function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return { id: row.id, slug: row.slug, title: row.title, visibility: row.visibility };
}
