import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export type DeliveryResidueMutationScope = {
  companyId: string;
  issueId: string;
};

export function deliveryResidueMutationLockKey(scope: DeliveryResidueMutationScope) {
  return `delivery-residue-mutation:${scope.companyId}:${scope.issueId}`;
}

/**
 * Shared transaction lock for issue work-product evidence used by delivery
 * residue linking and consolidation. Sorting makes multi-issue acquisition
 * deterministic so source/residue operations cannot deadlock each other.
 */
export async function acquireDeliveryResidueMutationLocks(
  dbOrTx: Db,
  scopes: readonly DeliveryResidueMutationScope[],
) {
  const uniqueScopes = new Map<string, DeliveryResidueMutationScope>();
  for (const scope of scopes) uniqueScopes.set(deliveryResidueMutationLockKey(scope), scope);
  for (const key of [...uniqueScopes.keys()].sort()) {
    await dbOrTx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
