import { and, asc, eq, isNull } from "drizzle-orm";
import type { PostgresRuntime, TenantContext } from "@/db/postgres/runtime";
import { guestSessions, learners, workspaceMembers, workspaces } from "@/db/postgres/schema";

export type WorkspaceVisibility = "private" | "link" | "public";

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
      input: { id: string; slug: string; title: string; visibility: WorkspaceVisibility },
    ): Promise<void> {
      await runtime.withTenant(context, async ({ db }) => {
        await db.insert(workspaces).values({
          id: input.id,
          slug: input.slug,
          title: input.title,
          visibility: input.visibility,
          createdByLearnerId: context.learnerId,
        });
        await db.insert(workspaceMembers).values({
          workspaceId: input.id,
          learnerId: context.learnerId,
          role: "owner",
        });
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
