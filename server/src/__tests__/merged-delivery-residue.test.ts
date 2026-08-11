import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  instanceSettings,
  issueComments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  mergedDeliveryResidueService,
  structuredPullRequestReference,
} from "../services/merged-delivery-residue.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres merged-delivery residue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeCommitSha = "c".repeat(40);
const pullRequestUrl = "https://github.com/paperclipai/paperclip/pull/321";
const reference = { host: "github.com", owner: "paperclipai", repo: "paperclip", number: 321 } as const;

function mergedDetails() {
  return {
    state: "merged" as const,
    repositoryId: "R_kgDOPaperclip",
    owner: reference.owner,
    repo: reference.repo,
    number: reference.number,
    headRef: "codex/governance",
    headSha,
    baseSha,
    mergeCommitSha,
    mergedAt: "2026-08-11T12:03:00.000Z",
    providerSnapshotId: "github:R_kgDOPaperclip:pull/321:snapshot-1",
    observedAt: "2026-08-11T12:05:00.000Z",
  };
}

describe("structured merged-delivery references", () => {
  it("accepts one matching structured GitHub pull-request identity", () => {
    expect(structuredPullRequestReference([{
      provider: "github",
      externalId: "paperclipai/paperclip#321",
      url: pullRequestUrl,
    }])).toEqual(reference);
  });

  it.each([
    ["non-GitHub provider", [{ provider: "gitlab", externalId: "paperclipai/paperclip#321", url: pullRequestUrl }]],
    ["missing structured identity", [{ provider: "github", externalId: null, url: null }]],
    ["conflicting identity", [{ provider: "github", externalId: "paperclipai/paperclip#322", url: pullRequestUrl }]],
    ["a GitHub pull request embedded in a foreign-host URL", [{
      provider: "github",
      externalId: null,
      url: "https://evil.example/https://github.com/paperclipai/paperclip/pull/321",
    }]],
    ["a malformed pull-request number suffix", [{
      provider: "github",
      externalId: null,
      url: "https://github.com/paperclipai/paperclip/pull/321-not-a-pr",
    }]],
    ["ambiguous references", [
      { provider: "github", externalId: null, url: pullRequestUrl },
      { provider: "github", externalId: null, url: "https://github.com/paperclipai/paperclip/pull/322" },
    ]],
  ])("rejects %s", (_label, products) => {
    expect(structuredPullRequestReference(products)).toBeNull();
  });
});

describeEmbeddedPostgres("merged-delivery residue consolidation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merged-delivery-residue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndSource() {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Ship decision governance",
      status: "done",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: sourceIssueId,
      type: "pull_request",
      provider: "github",
      externalId: "paperclipai/paperclip#321",
      title: "PR #321",
      url: pullRequestUrl,
      status: "merged",
    });
    return { companyId, sourceIssueId };
  }

  async function seedResidue(companyId: string, sourceIssueId: string) {
    const courierId = randomUUID();
    const shepherdId = randomUUID();
    const pollerId = randomUUID();
    const sourceReviewId = randomUUID();
    const mismatchedId = randomUUID();
    const unrelatedId = randomUUID();
    await db.insert(issues).values([
      { id: courierId, companyId, title: "Courier", status: "todo", originKind: "delivery_courier", originId: sourceIssueId, updatedAt: new Date("2026-08-11T10:00:00Z") },
      { id: shepherdId, companyId, title: "Shepherd", status: "blocked", originKind: "delivery_shepherd", originId: sourceIssueId, updatedAt: new Date("2026-08-11T10:01:00Z") },
      { id: pollerId, companyId, title: "Poller", status: "backlog", originKind: "delivery_poller", originId: sourceIssueId, updatedAt: new Date("2026-08-11T10:02:00Z") },
      { id: sourceReviewId, companyId, title: "Source review", status: "in_review", originKind: "delivery_source_review", originId: sourceIssueId, updatedAt: new Date("2026-08-11T10:03:00Z") },
      { id: mismatchedId, companyId, title: "Different PR", status: "todo", originKind: "delivery_courier", originId: sourceIssueId, updatedAt: new Date("2026-08-11T11:00:00Z") },
      { id: unrelatedId, companyId, title: "Unrelated courier", status: "todo", originKind: "delivery_courier", originId: randomUUID(), updatedAt: new Date("2026-08-11T12:00:00Z") },
    ]);
    await db.insert(issueWorkProducts).values([
      ...[courierId, shepherdId, pollerId].map((issueId) => ({
        companyId,
        issueId,
        type: "pull_request" as const,
        provider: "github",
        externalId: "paperclipai/paperclip#321",
        title: "PR #321",
        url: pullRequestUrl,
        status: "open",
      })),
      {
        companyId,
        issueId: sourceReviewId,
        type: "pull_request",
        provider: "github",
        externalId: "paperclipai/paperclip#321",
        title: "PR #321",
        url: pullRequestUrl,
        status: "open",
      },
      {
        companyId,
        issueId: mismatchedId,
        type: "pull_request",
        provider: "github",
        externalId: "paperclipai/paperclip#322",
        title: "PR #322",
        url: "https://github.com/paperclipai/paperclip/pull/322",
        status: "open",
      },
    ]);
    await db.insert(issueComments).values({
      companyId,
      issueId: courierId,
      authorUserId: "local-board",
      authorType: "user",
      body: "Preserve this delivery history.",
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "test.preexisting",
      entityType: "issue",
      entityId: courierId,
    });
    return { courierId, shepherdId, pollerId, sourceReviewId, mismatchedId, unrelatedId };
  }

  it("retires only explicitly related residue, preserves history, audits once, and is idempotent", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const residue = await seedResidue(companyId, sourceIssueId);
    const resolvePullRequestDetails = vi.fn(async () => mergedDetails());
    const service = mergedDeliveryResidueService(db, { resolvePullRequestDetails });

    await expect(service.sweep({ limit: 1 })).resolves.toEqual({
      checked: 1,
      candidates: 1,
      mergedSources: 1,
      retiredIssues: 4,
    });

    const retired = await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, [
      residue.courierId,
      residue.shepherdId,
      residue.pollerId,
      residue.sourceReviewId,
      residue.mismatchedId,
      residue.unrelatedId,
    ]));
    expect(new Map(retired.map((row) => [row.id, row.status]))).toEqual(new Map([
      [residue.courierId, "cancelled"],
      [residue.shepherdId, "cancelled"],
      [residue.pollerId, "cancelled"],
      [residue.sourceReviewId, "cancelled"],
      [residue.mismatchedId, "todo"],
      [residue.unrelatedId, "todo"],
    ]));
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, residue.courierId))).resolves.toHaveLength(1);
    const consolidationEvents = await db.select().from(activityLog).where(eq(activityLog.action, "delivery.residue_consolidated"));
    expect(consolidationEvents).toHaveLength(1);
    expect(consolidationEvents[0]?.details).toMatchObject({
      pullRequest: pullRequestUrl,
      mergeCommitSha,
      retiredIssueIds: expect.arrayContaining([
        residue.courierId,
        residue.shepherdId,
        residue.pollerId,
        residue.sourceReviewId,
      ]),
    });
    await expect(db.select().from(activityLog).where(eq(activityLog.action, "test.preexisting"))).resolves.toHaveLength(1);

    await expect(service.sweep()).resolves.toEqual({
      checked: 1,
      candidates: 2,
      mergedSources: 0,
      retiredIssues: 0,
    });
    await expect(db.select().from(activityLog).where(eq(activityLog.action, "delivery.residue_consolidated"))).resolves.toHaveLength(1);
  });

  it("requires every retired residue issue to carry the same structured pull request", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const residueId = randomUUID();
    await db.insert(issues).values({
      id: residueId,
      companyId,
      title: "Unproven courier",
      status: "todo",
      originKind: "delivery_courier",
      originId: sourceIssueId,
    });

    await expect(mergedDeliveryResidueService(db, {
      resolvePullRequestDetails: async () => mergedDetails(),
    }).sweep()).resolves.toMatchObject({ mergedSources: 0, retiredIssues: 0 });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, residueId)))
      .resolves.toEqual([{ status: "todo" }]);
  });

  it("advances past an open source so a later merged source is not starved", async () => {
    const first = await seedCompanyAndSource();
    const secondSourceId = randomUUID();
    const openResidueId = randomUUID();
    const mergedResidueId = randomUUID();
    await db.insert(issues).values([
      { id: secondSourceId, companyId: first.companyId, title: "Second delivery", status: "done" },
      { id: openResidueId, companyId: first.companyId, title: "Open courier", status: "todo", originKind: "delivery_courier", originId: first.sourceIssueId, updatedAt: new Date("2026-08-11T10:00:00Z") },
      { id: mergedResidueId, companyId: first.companyId, title: "Merged courier", status: "todo", originKind: "delivery_courier", originId: secondSourceId, updatedAt: new Date("2026-08-11T11:00:00Z") },
    ]);
    await db.insert(issueWorkProducts).values([
      { companyId: first.companyId, issueId: openResidueId, type: "pull_request", provider: "github", externalId: "paperclipai/paperclip#321", title: "PR #321", url: pullRequestUrl, status: "open" },
      { companyId: first.companyId, issueId: secondSourceId, type: "pull_request", provider: "github", externalId: "paperclipai/paperclip#322", title: "PR #322", url: "https://github.com/paperclipai/paperclip/pull/322", status: "merged" },
      { companyId: first.companyId, issueId: mergedResidueId, type: "pull_request", provider: "github", externalId: "paperclipai/paperclip#322", title: "PR #322", url: "https://github.com/paperclipai/paperclip/pull/322", status: "open" },
    ]);
    const service = mergedDeliveryResidueService(db, {
      resolvePullRequestDetails: async (_companyId, pullRequest) => pullRequest.number === 322
        ? { ...mergedDetails(), number: 322 }
        : { ...mergedDetails(), state: "open", repositoryId: null, baseSha: null, mergeCommitSha: null, mergedAt: null, providerSnapshotId: null, observedAt: null },
    });

    await expect(service.sweep({ limit: 1 })).resolves.toMatchObject({ retiredIssues: 0 });
    await expect(service.sweep({ limit: 1 })).resolves.toMatchObject({ retiredIssues: 1 });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, mergedResidueId)))
      .resolves.toEqual([{ status: "cancelled" }]);
  });

  it("revisits an earlier source within a bounded scan epoch while newer residue keeps arriving", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const oldResidueId = randomUUID();
    await db.insert(issues).values([
      { id: oldResidueId, companyId, title: "Old courier", status: "todo", originKind: "delivery_courier", originId: sourceIssueId, updatedAt: new Date("2026-08-11T10:00:00Z") },
      { id: randomUUID(), companyId, title: "Epoch tail", status: "todo", originKind: "delivery_courier", originId: randomUUID(), updatedAt: new Date("2026-08-11T11:00:00Z") },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId, issueId: oldResidueId, type: "pull_request", provider: "github",
      externalId: "paperclipai/paperclip#321", title: "PR #321", url: pullRequestUrl, status: "open",
    });
    let merged = false;
    const service = mergedDeliveryResidueService(db, {
      resolvePullRequestDetails: async () => merged
        ? mergedDetails()
        : { ...mergedDetails(), state: "open", repositoryId: null, baseSha: null, mergeCommitSha: null, mergedAt: null, providerSnapshotId: null, observedAt: null },
    });

    await expect(service.sweep({ limit: 1 })).resolves.toMatchObject({ retiredIssues: 0 });
    merged = true;
    for (let index = 0; index < 2; index += 1) {
      await db.insert(issues).values({
        id: randomUUID(), companyId, title: `Continuous arrival ${index}`, status: "todo",
        originKind: "delivery_courier", originId: randomUUID(), updatedAt: new Date(`2026-08-11T1${index + 2}:00:00Z`),
      });
      await service.sweep({ limit: 1 });
    }

    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, oldResidueId)))
      .resolves.toEqual([{ status: "cancelled" }]);
  });

  it("uses the validated production linker before the scheduler can retire residue", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const residueIssueId = randomUUID();
    await db.insert(issues).values({
      id: residueIssueId,
      companyId,
      title: "Delivery courier",
      status: "todo",
      originKind: "manual",
    });
    const service = mergedDeliveryResidueService(db, { resolvePullRequestDetails: async () => mergedDetails() });

    await expect(service.createLinkedWorkProduct({
      companyId,
      residueIssueId,
      sourceIssueId,
      originKind: "delivery_courier",
      workProduct: {
        type: "pull_request",
        provider: "github",
        externalId: "paperclipai/paperclip#321",
        title: "PR #321",
        url: pullRequestUrl,
        status: "open",
      },
    })).resolves.toMatchObject({ linked: { alreadyLinked: false, sourceIssueId, residueIssueId } });
    await expect(db.select({ originKind: issues.originKind, originId: issues.originId }).from(issues).where(eq(issues.id, residueIssueId)))
      .resolves.toEqual([{ originKind: "delivery_courier", originId: sourceIssueId }]);

    await expect(service.sweep()).resolves.toMatchObject({ mergedSources: 1, retiredIssues: 1 });
    await expect(db.select({ status: issues.status }).from(issues).where(eq(issues.id, residueIssueId)))
      .resolves.toEqual([{ status: "cancelled" }]);
    await expect(db.select().from(activityLog).where(eq(activityLog.action, "delivery.residue_linked")))
      .resolves.toHaveLength(1);
  });

  it("rolls back primary work-product changes when a production link is invalid", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const residueIssueId = randomUUID();
    await db.insert(issues).values({ id: residueIssueId, companyId, title: "Courier", status: "todo", originKind: "manual" });
    const [prior] = await db.insert(issueWorkProducts).values({
      companyId,
      issueId: residueIssueId,
      type: "pull_request",
      provider: "github",
      externalId: "paperclipai/paperclip#322",
      title: "Prior PR",
      url: "https://github.com/paperclipai/paperclip/pull/322",
      status: "open",
      isPrimary: true,
    }).returning();
    const service = mergedDeliveryResidueService(db);

    await expect(service.createLinkedWorkProduct({
      companyId,
      residueIssueId,
      sourceIssueId,
      originKind: "delivery_courier",
      workProduct: {
        type: "pull_request",
        provider: "github",
        externalId: "paperclipai/paperclip#999",
        title: "Mismatched PR",
        url: "https://github.com/paperclipai/paperclip/pull/999",
        status: "open",
        isPrimary: true,
      },
    })).rejects.toThrow("same structured pull request");

    await expect(db.select({ id: issueWorkProducts.id, isPrimary: issueWorkProducts.isPrimary }).from(issueWorkProducts).where(eq(issueWorkProducts.issueId, residueIssueId)))
      .resolves.toEqual([{ id: prior!.id, isPrimary: true }]);
    await expect(db.select({ originKind: issues.originKind, originId: issues.originId }).from(issues).where(eq(issues.id, residueIssueId)))
      .resolves.toEqual([{ originKind: "manual", originId: null }]);
    await expect(db.select().from(activityLog).where(eq(activityLog.action, "delivery.residue_linked")))
      .resolves.toHaveLength(0);
  });

  it("rolls back a malformed structured URL without stamping origin or audit provenance", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const residueIssueId = randomUUID();
    await db.insert(issues).values({
      id: residueIssueId,
      companyId,
      title: "Courier",
      status: "todo",
      originKind: "manual",
    });
    const service = mergedDeliveryResidueService(db);

    await expect(service.createLinkedWorkProduct({
      companyId,
      residueIssueId,
      sourceIssueId,
      originKind: "delivery_courier",
      workProduct: {
        type: "pull_request",
        provider: "github",
        title: "Malformed PR URL",
        url: "https://evil.example/https://github.com/paperclipai/paperclip/pull/321",
        status: "open",
      },
    })).rejects.toThrow("same structured pull request");

    await expect(db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, residueIssueId)))
      .resolves.toHaveLength(0);
    await expect(db.select({ originKind: issues.originKind, originId: issues.originId }).from(issues).where(eq(issues.id, residueIssueId)))
      .resolves.toEqual([{ originKind: "manual", originId: null }]);
    await expect(db.select().from(activityLog).where(eq(activityLog.action, "delivery.residue_linked")))
      .resolves.toHaveLength(0);
  });

  it.each(["open", "unknown"] as const)("does not mutate residue when provider state is %s", async (state) => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const residue = await seedResidue(companyId, sourceIssueId);
    const service = mergedDeliveryResidueService(db, {
      resolvePullRequestDetails: async () => ({
        state,
        headRef: state === "open" ? "codex/governance" : null,
        headSha: state === "open" ? headSha : null,
        mergeCommitSha: null,
        repositoryId: null,
        owner: reference.owner,
        repo: reference.repo,
        number: reference.number,
        baseSha: null,
        mergedAt: null,
        providerSnapshotId: null,
        observedAt: null,
      }),
    });

    await expect(service.sweep()).resolves.toMatchObject({ mergedSources: 0, retiredIssues: 0 });
    await expect(db.select().from(issues).where(eq(issues.id, residue.courierId))).resolves.toMatchObject([
      { status: "todo" },
    ]);
    await expect(db.select().from(activityLog).where(eq(activityLog.action, "delivery.residue_consolidated"))).resolves.toHaveLength(0);
  });

  it("does not call the provider or mutate when source evidence is ambiguous", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndSource();
    const residue = await seedResidue(companyId, sourceIssueId);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: sourceIssueId,
      type: "pull_request",
      provider: "github",
      externalId: "paperclipai/paperclip#999",
      title: "PR #999",
      url: "https://github.com/paperclipai/paperclip/pull/999",
      status: "open",
    });
    const resolvePullRequestDetails = vi.fn(async () => mergedDetails());

    await expect(mergedDeliveryResidueService(db, { resolvePullRequestDetails }).sweep()).resolves.toMatchObject({
      mergedSources: 0,
      retiredIssues: 0,
    });
    expect(resolvePullRequestDetails).not.toHaveBeenCalled();
    await expect(db.select().from(issues).where(eq(issues.id, residue.courierId))).resolves.toMatchObject([
      { status: "todo" },
    ]);
  });
});
