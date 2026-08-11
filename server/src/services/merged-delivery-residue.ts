import { and, asc, desc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues } from "@paperclipai/db";
import { DELIVERY_RESIDUE_ORIGIN_KINDS, isUuidLike } from "@paperclipai/shared";
import {
  createPullRequestMergeDetailsResolver,
  type GitHubPullRequestReference,
  type PullRequestMergeDetailsResolver,
} from "./github-pull-request-merge.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueService } from "./issues.js";
import { toIssueWorkProduct } from "./work-products.js";

export const MERGED_DELIVERY_RESIDUE_ORIGIN_KINDS = DELIVERY_RESIDUE_ORIGIN_KINDS;

type ResidueOriginKind = (typeof MERGED_DELIVERY_RESIDUE_ORIGIN_KINDS)[number];

type PullRequestWorkProduct = {
  provider: string;
  externalId: string | null;
  url: string | null;
};

export type MergedDeliveryResidueSweepResult = {
  checked: number;
  candidates: number;
  mergedSources: number;
  retiredIssues: number;
};

function referenceKey(reference: GitHubPullRequestReference) {
  return `${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
}

function externalIdReference(value: string | null): GitHubPullRequestReference[] {
  if (!value) return [];
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(?:pull\/)?([1-9][0-9]*)$/.exec(value.trim());
  if (!match) return [];
  return [{ host: "github.com", owner: match[1]!, repo: match[2]!, number: Number(match[3]) }];
}

function structuredUrlReference(value: string | null): GitHubPullRequestReference[] {
  if (!value) return [];
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return [];
  }
  const host = parsed.host.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "github.com" && host !== "www.github.com")) return [];
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)\/?$/.exec(parsed.pathname);
  if (!match) return [];
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return [];
  return [{ host: "github.com", owner: match[1]!, repo: match[2]!, number }];
}

/**
 * Resolves only explicit structured pull-request work products. Prose, issue
 * titles, branch names, and local Git state are intentionally excluded.
 */
export function structuredPullRequestReference(
  products: readonly PullRequestWorkProduct[],
): GitHubPullRequestReference | null {
  const references = new Map<string, GitHubPullRequestReference>();
  for (const product of products) {
    if (product.provider.toLowerCase() !== "github") return null;
    const candidates = [
      ...structuredUrlReference(product.url),
      ...externalIdReference(product.externalId),
    ];
    if (candidates.length === 0) return null;
    for (const candidate of candidates) references.set(referenceKey(candidate), candidate);
  }
  return references.size === 1 ? [...references.values()][0]! : null;
}

function sameReference(left: GitHubPullRequestReference, right: GitHubPullRequestReference) {
  return referenceKey(left) === referenceKey(right);
}

function activeResidueCondition() {
  return sql<boolean>`${issues.hiddenAt} is null and ${issues.status} not in ('done', 'cancelled')`;
}

export function mergedDeliveryResidueService(db: Db, options: {
  resolvePullRequestDetails?: PullRequestMergeDetailsResolver;
  now?: () => Date;
} = {}) {
  const resolvePullRequestDetails = options.resolvePullRequestDetails ?? createPullRequestMergeDetailsResolver(db);
  const now = options.now ?? (() => new Date());
  let scanCursor: { updatedAt: Date; id: string } | null = null;
  let scanHighWater: { updatedAt: Date; id: string } | null = null;

  async function workProductsByIssue(dbOrTx: Db, companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return new Map<string, PullRequestWorkProduct[]>();
    const rows = await dbOrTx.select({
      issueId: issueWorkProducts.issueId,
      provider: issueWorkProducts.provider,
      externalId: issueWorkProducts.externalId,
      url: issueWorkProducts.url,
    }).from(issueWorkProducts).where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.type, "pull_request"),
      inArray(issueWorkProducts.issueId, issueIds),
    ));
    const result = new Map<string, PullRequestWorkProduct[]>();
    for (const row of rows) {
      const group = result.get(row.issueId) ?? [];
      group.push(row);
      result.set(row.issueId, group);
    }
    return result;
  }

  async function consolidateSource(input: {
    companyId: string;
    sourceIssueId: string;
    reference: GitHubPullRequestReference;
  }) {
    const details = await resolvePullRequestDetails(input.companyId, input.reference);
    if (details.state !== "merged"
      || !details.repositoryId
      || !details.baseSha
      || !details.headSha
      || !details.mergeCommitSha
      || !details.mergedAt
      || !details.providerSnapshotId
      || !details.observedAt) return 0;

    const publications: ActivityPublication[] = [];
    const retired = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`merged-delivery-residue:${input.companyId}:${input.sourceIssueId}`}, 0))`);
      const source = await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.id, input.sourceIssueId),
      )).then((rows) => rows[0] ?? null);
      if (!source) return [] as Array<{ id: string; originKind: string }>;

      const current = await tx.select({
        id: issues.id,
        originKind: issues.originKind,
      }).from(issues).where(and(
        eq(issues.companyId, input.companyId),
        inArray(issues.originKind, [...MERGED_DELIVERY_RESIDUE_ORIGIN_KINDS]),
        eq(issues.originId, input.sourceIssueId),
        activeResidueCondition(),
      )).orderBy(asc(issues.id));
      if (current.length === 0) return [] as Array<{ id: string; originKind: string }>;

      const products = await workProductsByIssue(txDb, input.companyId, [input.sourceIssueId, ...current.map((row) => row.id)]);
      const sourceReference = structuredPullRequestReference(products.get(input.sourceIssueId) ?? []);
      if (!sourceReference || !sameReference(sourceReference, input.reference)) {
        return [] as Array<{ id: string; originKind: string }>;
      }
      const eligible = current.filter((row) => {
        const residueProducts = products.get(row.id) ?? [];
        if (residueProducts.length === 0) return false;
        const residueReference = structuredPullRequestReference(residueProducts);
        return residueReference !== null && sameReference(residueReference, input.reference);
      });
      if (eligible.length === 0) return [] as Array<{ id: string; originKind: string }>;

      const service = issueService(db);
      const updated: Array<{ id: string; originKind: string }> = [];
      for (const row of eligible) {
        const issue = await service.update(row.id, { status: "cancelled", actorAgentId: null, actorUserId: null }, tx, publications);
        if (issue) updated.push(row);
      }
      if (updated.length === 0) return updated;

      const { publication } = await persistActivity(txDb, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "merged-delivery-residue",
        action: "delivery.residue_consolidated",
        entityType: "issue",
        entityId: input.sourceIssueId,
        issueId: input.sourceIssueId,
        details: {
          pullRequest: `https://github.com/${input.reference.owner}/${input.reference.repo}/pull/${input.reference.number}`,
          repositoryId: details.repositoryId,
          pullRequestNumber: details.number,
          baseSha: details.baseSha,
          headSha: details.headSha,
          mergeCommitSha: details.mergeCommitSha,
          mergedAt: details.mergedAt,
          providerSnapshotId: details.providerSnapshotId,
          observedAt: details.observedAt,
          retiredIssueIds: updated.map((row) => row.id),
          residueOriginKinds: updated.map((row) => row.originKind),
        },
      });
      publications.push(publication);
      return updated;
    });
    for (const publication of publications) publishActivity(publication);
    return retired.length;
  }

  type LinkInput = {
    companyId: string;
    residueIssueId: string;
    sourceIssueId: string;
    originKind: ResidueOriginKind;
  };

  async function linkInStore(dbOrTx: Db, input: LinkInput, publications: ActivityPublication[]) {
    if (input.residueIssueId === input.sourceIssueId) throw new Error("Delivery residue cannot link to itself");
    await dbOrTx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`delivery-residue-link:${input.companyId}:${input.residueIssueId}`}, 0))`);
    const rows = await dbOrTx.select({
      id: issues.id,
      originKind: issues.originKind,
      originId: issues.originId,
    }).from(issues).where(and(
      eq(issues.companyId, input.companyId),
      inArray(issues.id, [input.sourceIssueId, input.residueIssueId]),
    ));
    if (rows.length !== 2) throw new Error("Delivery residue source or issue was not found");
    const residue = rows.find((row) => row.id === input.residueIssueId)!;
    const alreadyLinked = residue.originKind === input.originKind && residue.originId === input.sourceIssueId;
    if (!alreadyLinked && (residue.originKind !== "manual" || residue.originId !== null)) {
      throw new Error("Delivery residue already has immutable origin provenance");
    }
    const products = await workProductsByIssue(dbOrTx, input.companyId, [input.sourceIssueId, input.residueIssueId]);
    const sourceReference = structuredPullRequestReference(products.get(input.sourceIssueId) ?? []);
    const residueReference = structuredPullRequestReference(products.get(input.residueIssueId) ?? []);
    if (!sourceReference || !residueReference || !sameReference(sourceReference, residueReference)) {
      throw new Error("Delivery residue and source must carry the same structured pull request");
    }
    if (!alreadyLinked) {
      await dbOrTx.update(issues).set({
        originKind: input.originKind,
        originId: input.sourceIssueId,
        updatedAt: now(),
      }).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.residueIssueId)));
      const { publication } = await persistActivity(dbOrTx, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "delivery-residue-linker",
        action: "delivery.residue_linked",
        entityType: "issue",
        entityId: input.residueIssueId,
        issueId: input.residueIssueId,
        details: {
          sourceIssueId: input.sourceIssueId,
          originKind: input.originKind,
          pullRequest: `https://github.com/${sourceReference.owner}/${sourceReference.repo}/pull/${sourceReference.number}`,
        },
      });
      publications.push(publication);
    }
    return { ...input, pullRequest: sourceReference, alreadyLinked };
  }

  return {
    /**
     * Explicit, server-validated producer for delivery provenance. Callers do
     * not write originKind/originId directly: both issues must already carry
     * one unambiguous structured work product for the same pull request.
     */
    async link(input: {
      companyId: string;
      residueIssueId: string;
      sourceIssueId: string;
      originKind: ResidueOriginKind;
    }) {
      const publications: ActivityPublication[] = [];
      const linked = await db.transaction((tx) => linkInStore(tx as unknown as Db, input, publications));
      for (const publication of publications) publishActivity(publication);
      return linked;
    },

    async createLinkedWorkProduct(input: LinkInput & {
      workProduct: Omit<typeof issueWorkProducts.$inferInsert, "companyId" | "issueId">;
    }) {
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        if (input.workProduct.type !== "pull_request") {
          throw new Error("Delivery residue linkage requires a pull-request work product");
        }
        if (input.workProduct.isPrimary) {
          await tx.update(issueWorkProducts).set({ isPrimary: false, updatedAt: now() }).where(and(
            eq(issueWorkProducts.companyId, input.companyId),
            eq(issueWorkProducts.issueId, input.residueIssueId),
            eq(issueWorkProducts.type, input.workProduct.type),
          ));
        }
        const product = await tx.insert(issueWorkProducts).values({
          ...input.workProduct,
          companyId: input.companyId,
          issueId: input.residueIssueId,
        }).returning().then((rows) => rows[0] ?? null);
        if (!product) throw new Error("Delivery residue work product could not be created");
        const linked = await linkInStore(txDb, input, publications);
        return { product: toIssueWorkProduct(product), linked };
      });
      for (const publication of publications) publishActivity(publication);
      return result;
    },

    async sweep(input: { limit?: number } = {}): Promise<MergedDeliveryResidueSweepResult> {
      const configuredLimit = Number(input.limit ?? process.env.PAPERCLIP_MERGED_DELIVERY_RESIDUE_BATCH_SIZE ?? 100);
      const limit = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(500, Math.trunc(configuredLimit))) : 100;
      const baseCondition = and(
        inArray(issues.originKind, [...MERGED_DELIVERY_RESIDUE_ORIGIN_KINDS]),
        activeResidueCondition(),
      );
      if (scanHighWater === null) {
        scanHighWater = await db.select({ id: issues.id, updatedAt: issues.updatedAt })
          .from(issues)
          .where(baseCondition)
          .orderBy(desc(issues.updatedAt), desc(issues.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      }
      if (scanHighWater === null) {
        return { checked: 0, candidates: 0, mergedSources: 0, retiredIssues: 0 };
      }
      const atOrBeforeHighWater = or(
        lt(issues.updatedAt, scanHighWater.updatedAt),
        and(eq(issues.updatedAt, scanHighWater.updatedAt), lte(issues.id, scanHighWater.id)),
      );
      const loadCandidates = (cursor: typeof scanCursor) => db.select({
        id: issues.id,
        companyId: issues.companyId,
        originId: issues.originId,
        updatedAt: issues.updatedAt,
      }).from(issues).where(and(
        baseCondition,
        atOrBeforeHighWater,
        cursor ? or(
          gt(issues.updatedAt, cursor.updatedAt),
          and(eq(issues.updatedAt, cursor.updatedAt), gt(issues.id, cursor.id)),
        ) : undefined,
      )).orderBy(asc(issues.updatedAt), asc(issues.id)).limit(limit);
      let candidates = await loadCandidates(scanCursor);
      if (candidates.length === 0) {
        scanCursor = null;
        scanHighWater = null;
        return { checked: 0, candidates: 0, mergedSources: 0, retiredIssues: 0 };
      }
      const lastCandidate = candidates.at(-1);
      const epochComplete = lastCandidate?.updatedAt.getTime() === scanHighWater.updatedAt.getTime()
        && lastCandidate.id === scanHighWater.id;
      if (lastCandidate && !epochComplete) {
        scanCursor = { updatedAt: lastCandidate.updatedAt, id: lastCandidate.id };
      } else {
        scanCursor = null;
        scanHighWater = null;
      }

      const grouped = new Map<string, { companyId: string; sourceIssueId: string }>();
      for (const candidate of candidates) {
        if (!candidate.originId || !isUuidLike(candidate.originId)) continue;
        const key = `${candidate.companyId}:${candidate.originId}`;
        if (!grouped.has(key)) grouped.set(key, { companyId: candidate.companyId, sourceIssueId: candidate.originId });
      }

      let mergedSources = 0;
      let retiredIssues = 0;
      let checked = 0;
      for (const group of grouped.values()) {
        const products = await workProductsByIssue(db, group.companyId, [group.sourceIssueId]);
        const reference = structuredPullRequestReference(products.get(group.sourceIssueId) ?? []);
        if (!reference) continue;
        checked += 1;
        const retired = await consolidateSource({ ...group, reference });
        if (retired > 0) {
          mergedSources += 1;
          retiredIssues += retired;
        }
      }
      return { checked, candidates: candidates.length, mergedSources, retiredIssues };
    },
  };
}
