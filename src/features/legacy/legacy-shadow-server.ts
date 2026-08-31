import { getPostgresServerRuntime } from "@/db/postgres/server";
import { getDb } from "@/lib/db";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { readLegacyBankData, type LegacyBankData } from "./legacy-snapshot";
import { createLegacyShadowWriteService } from "./legacy-shadow-write";

type ShadowMetadata =
  | { state: "synced"; action: "created" | "updated" | "replayed" | "deleted" | "missing" }
  | { state: "pending_reconciliation"; error_code: "shadow_write_failed" };

export async function syncLegacyBankShadow(slug: string): Promise<ShadowMetadata | undefined> {
  if (!isFeatureEnabled("postgres_shadow_write")) return undefined;
  const bank = readLegacyBankData(getDb(), slug);
  if (!bank) return pending("sync", slug);
  try {
    const result = await createLegacyShadowWriteService(getPostgresServerRuntime()).sync(bank);
    return { state: "synced", action: result.status };
  } catch {
    return pending("sync", slug);
  }
}

export function captureLegacyBankForShadow(slug: string): LegacyBankData | undefined {
  return isFeatureEnabled("postgres_shadow_write") ? readLegacyBankData(getDb(), slug) : undefined;
}

export async function deleteLegacyBankShadow(bank: LegacyBankData | undefined): Promise<ShadowMetadata | undefined> {
  if (!isFeatureEnabled("postgres_shadow_write")) return undefined;
  if (!bank) return pending("delete", "unknown");
  try {
    const result = await createLegacyShadowWriteService(getPostgresServerRuntime()).remove({
      slug: bank.slug,
      ownerKeyHash: bank.ownerKeyHash,
    });
    return { state: "synced", action: result.status };
  } catch {
    return pending("delete", bank.slug);
  }
}

function pending(operation: "sync" | "delete", slug: string): ShadowMetadata {
  console.error("legacy_shadow_write_pending_reconciliation", { operation, slug });
  return { state: "pending_reconciliation", error_code: "shadow_write_failed" };
}
