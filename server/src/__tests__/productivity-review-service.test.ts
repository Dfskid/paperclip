import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { MAX_ISSUE_REQUEST_DEPTH } from "@paperclipai/shared";
import {
  DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
  DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
  DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
  DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
  PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX,
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  productivityReviewService,
} from "../services/productivity-review.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres productivity review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("productivity review service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-productivity-review-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedAssignedIssue(opts?: {
    status?: "todo" | "in_progress";
    startedAt?: Date;
    parentId?: string | null;
    originKind?: string;
    blockedTransitionAt?: Date | null;
  }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `PR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const createdAt = new Date("2026-04-28T10:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Productivity Review Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement data import",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      parentId: opts?.parentId ?? null,
      originKind: opts?.originKind ?? "manual",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: opts?.startedAt ?? createdAt,
      blockedTransitionAt: opts?.blockedTransitionAt ?? null,
      createdAt,
      updatedAt: createdAt,
    });

    return { companyId, managerId, coderId, issueId, issuePrefix, createdAt };
  }

  async function insertRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    count: number;
    now: Date;
    withRunComments?: boolean;
  }) {
    const runs: Array<typeof heartbeatRuns.$inferInsert> = [];
    for (let index = 0; index < input.count; index += 1) {
      const runId = randomUUID();
      const createdAt = new Date(input.now.getTime() - index * 60_000);
      runs.push({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
        livenessState: "advanced",
        nextAction: "Continue processing the next batch.",
        createdAt,
        updatedAt: createdAt,
      });
    }
    await db.insert(heartbeatRuns).values(runs);

    if (input.withRunComments) {
      await db.insert(issueComments).values(
        runs.map((run, index) => ({
          companyId: input.companyId,
          issueId: input.issueId,
          authorAgentId: input.agentId,
          createdByRunId: run.id,
          body: `Progress update ${index}`,
          createdAt: run.createdAt as Date,
          updatedAt: run.createdAt as Date,
        })),
      );
    }

    return runs;
  }

  async function listProductivityReviews(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND)))
      .orderBy(issues.createdAt);
  }

  async function listRefreshComments(reviewIssueId: string) {
    return db
      .select()
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, reviewIssueId),
        sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
      ))
      .orderBy(issueComments.createdAt);
  }

  it("creates exactly one manager-assigned review for a no-comment run streak and rate-limits immediate refresh", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    const first = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const second = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(first.created).toBe(1);
    expect(second.updated).toBe(0);
    expect(second.existing).toBe(1);
    const reviews = await listProductivityReviews(seeded.companyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.parentId).toBe(seeded.issueId);
    expect(reviews[0]?.assigneeAgentId).toBe(seeded.managerId);
    expect(reviews[0]?.assigneeAdapterOverrides).toEqual({ modelProfile: "cheap" });
    expect(reviews[0]?.originId).toBe(seeded.issueId);
    expect(reviews[0]?.originFingerprint).toBe(`productivity-review:${seeded.issueId}`);
    expect(reviews[0]?.description).toContain("Primary trigger: `no_comment_streak`");
    expect(reviews[0]?.description).toContain("No-comment completed-run streak: 10");

    expect(await listRefreshComments(reviews[0]!.id)).toHaveLength(0);
  });

  it("refreshes open productivity reviews only once per interval and caps refresh comments", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const firstRefreshAt = new Date(now.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS);
    const firstRefresh = await service.reconcileProductivityReviews({
      now: firstRefreshAt,
      companyId: seeded.companyId,
    });
    const tooSoonRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 2 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });
    const cappedRefresh = await service.reconcileProductivityReviews({
      now: new Date(firstRefreshAt.getTime() + 3 * DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS),
      companyId: seeded.companyId,
    });

    expect(firstRefresh.updated).toBe(1);
    expect(tooSoonRefresh.updated).toBe(0);
    expect(tooSoonRefresh.existing).toBe(1);
    expect(cappedRefresh.updated).toBe(0);
    expect(cappedRefresh.existing).toBe(1);
    expect(await listRefreshComments(review!.id)).toHaveLength(DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS);
  });

  it("allows only one productivity review per source issue in 24 hours", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const createdAt = new Date(now.getTime() - 8 * 60 * 60 * 1000);
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Completed productivity review",
      status: "done",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt,
      updatedAt: createdAt,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      // Shrink the resolved-review snooze below the 8h-old seed so this test
      // exercises the creation cap in isolation from the snooze window.
      thresholds: { resolvedSnoozeMs: 60 * 60 * 1000 },
    });

    expect(result.created).toBe(0);
    expect(result.creationCapped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("suppresses creation after three consecutive completed reviews with no source action", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      [96, 72, 48].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `No-action productivity review ${index + 1}`,
          status: "done",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.noActionSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("resets no-action suppression for source action after a zero-duration review", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const reviewWindows = [96, 72, 48].map((hoursAgo, index) => {
      const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
      return {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Productivity review ${index + 1}`,
        status: "done" as const,
        priority: "high" as const,
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: index + 2,
        identifier: `${seeded.issuePrefix}-${index + 2}`,
        createdAt,
        updatedAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
      };
    });
    const actedReview = reviewWindows[1]!;
    actedReview.updatedAt = actedReview.createdAt;
    await db.insert(issues).values(reviewWindows);
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.coderId,
      agentId: seeded.coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      createdAt: new Date(actedReview.createdAt.getTime() + 2 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    expect(result.noActionSuppressed).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(4);
  });

  it("uses review creation order for no-action streak windows", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    const reviewWindows = [
      { hoursAgo: 96, updatedAt: new Date(now.getTime() - 95 * 60 * 60 * 1000) },
      { hoursAgo: 72, updatedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000) },
      { hoursAgo: 48, updatedAt: new Date(now.getTime() - 47 * 60 * 60 * 1000) },
    ].map((window, index) => {
      const createdAt = new Date(now.getTime() - window.hoursAgo * 60 * 60 * 1000);
      return {
        id: randomUUID(),
        companyId: seeded.companyId,
        title: `Productivity review ordered window ${index + 1}`,
        status: "done" as const,
        priority: "high" as const,
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: seeded.issueId,
        originFingerprint: `productivity-review:${seeded.issueId}`,
        parentId: seeded.issueId,
        issueNumber: index + 2,
        identifier: `${seeded.issuePrefix}-${index + 2}`,
        createdAt,
        updatedAt: window.updatedAt,
      };
    });
    const middleReviewCreatedAt = reviewWindows[1]!.createdAt;
    await db.insert(issues).values(reviewWindows);
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "agent",
      actorId: seeded.coderId,
      agentId: seeded.coderId,
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      createdAt: new Date(middleReviewCreatedAt.getTime() + 60_000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      // The middle review's updatedAt is 7h old; keep the snooze below that so
      // this test exercises the no-action streak ordering, not the snooze window.
      thresholds: { maxConsecutiveNoActionReviews: 1, resolvedSnoozeMs: 6 * 60 * 60 * 1000 },
    });

    expect(result.created).toBe(0);
    expect(result.noActionSuppressed).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(3);
  });

  it("does not count cancelled productivity reviews toward the creation cap", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await db.insert(issues).values(
      [8, 9, 10].map((hoursAgo, index) => {
        const createdAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
        return {
          id: randomUUID(),
          companyId: seeded.companyId,
          title: `Cancelled productivity review ${index + 1}`,
          status: "cancelled",
          priority: "high",
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: seeded.issueId,
          originFingerprint: `productivity-review:${seeded.issueId}`,
          parentId: seeded.issueId,
          issueNumber: index + 2,
          identifier: `${seeded.issuePrefix}-${index + 2}`,
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      // Shrink the snooze below the 8-10h-old cancelled seeds so this test
      // exercises the creation cap's cancelled-exclusion in isolation.
      thresholds: { resolvedSnoozeMs: 60 * 60 * 1000 },
    });

    expect(result.created).toBe(1);
    expect(result.creationCapped).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(4);
  });

  it("creates a long-active review without enabling a continuation hold", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    const service = productivityReviewService(db);

    const result = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
    expect(review?.priority).toBe("medium");
    expect(hold.held).toBe(false);
  });

  it("skips a long-active candidate while its assignee is paused and reviews it once unpaused", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, seeded.coderId));
    const service = productivityReviewService(db);

    const pausedResult = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(pausedResult.created).toBe(0);
    expect(pausedResult.skipped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);

    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, seeded.coderId));
    const unpausedResult = await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });

    expect(unpausedResult.created).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("suppresses the long-active trigger when the source was durably human-blocked", async () => {
    // Regression for OWN-131: an issue that was explicitly blocked on a human
    // for longer than the long-active threshold (e.g. waiting on a manual
    // deploy) must not re-fire the long_active_duration review on every
    // reconciliation tick, even after the status flaps back to in_progress.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000),
      blockedTransitionAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("still fires the long-active trigger when the blocked transition is recent", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000),
      blockedTransitionAt: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("suppresses the long-active trigger when the issue has an unresolved explicit blocker relation (OWN-131)", async () => {
    // Regression for OWN-131: an issue with in_progress status but an
    // unresolved blocker relation must not fire long_active_duration even
    // though blockedTransitionAt is null (status never formally transitioned
    // to blocked).
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000),
    });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId: seeded.companyId,
      title: "Deploy to production",
      status: "in_progress",
      priority: "high",
      issueNumber: 100,
      identifier: `${seeded.issuePrefix}-100`,
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      issueId: blockerIssueId,
      relatedIssueId: seeded.issueId,
      type: "blocks",
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("fires the long-active trigger when the blocker is done and no other blockers remain (OWN-131)", async () => {
    // When a blocker is complete (status=done), the issue is no longer
    // durably blocked and long_active_duration should fire normally.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000),
    });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId: seeded.companyId,
      title: "Completed deploy",
      status: "done",
      priority: "high",
      issueNumber: 100,
      identifier: `${seeded.issuePrefix}-100`,
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      issueId: blockerIssueId,
      relatedIssueId: seeded.issueId,
      type: "blocks",
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `long_active_duration`");
  });

  it("suppresses the long-active trigger when both blockedTransitionAt and blocker relation exist (OWN-131)", async () => {
    // Even when both forms of blocked signal are present, it should suppress.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000),
      blockedTransitionAt: new Date(now.getTime() - 30 * 60 * 60 * 1000),
    });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId: seeded.companyId,
      title: "Deploy to production",
      status: "in_progress",
      priority: "high",
      issueNumber: 100,
      identifier: `${seeded.issuePrefix}-100`,
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      issueId: blockerIssueId,
      relatedIssueId: seeded.issueId,
      type: "blocks",
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("suppresses the long-active trigger when the issue has multiple blockers and only some are done (OWN-131)", async () => {
    // Partial blocker resolution should still suppress: if any blocker
    // remains unresolved, the issue is durably blocked.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000),
    });
    const doneBlockerId = randomUUID();
    const unresolvedBlockerId = randomUUID();
    await db.insert(issues).values([
      {
        id: doneBlockerId,
        companyId: seeded.companyId,
        title: "PR approved",
        status: "done",
        priority: "high",
        issueNumber: 100,
        identifier: `${seeded.issuePrefix}-100`,
        createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
      },
      {
        id: unresolvedBlockerId,
        companyId: seeded.companyId,
        title: "Deploy to production",
        status: "in_progress",
        priority: "high",
        issueNumber: 101,
        identifier: `${seeded.issuePrefix}-101`,
        createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      },
    ]);
    await db.insert(issueRelations).values([
      {
        id: randomUUID(),
        companyId: seeded.companyId,
        issueId: doneBlockerId,
        relatedIssueId: seeded.issueId,
        type: "blocks",
        createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      },
      {
        id: randomUUID(),
        companyId: seeded.companyId,
        issueId: unresolvedBlockerId,
        relatedIssueId: seeded.issueId,
        type: "blocks",
        createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      },
    ]);

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("suppresses the long-active trigger when the blocker is cancelled (OWN-131)", async () => {
    // A cancelled blocker does NOT resolve the blocking relation; the
    // issue is still effectively blocked until the relation is cleared.
    // This matches the existing `listUnresolvedBlockerIssueIds` behaviour
    // where cancelled blockers remain unresolved.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue({
      status: "in_progress",
      startedAt: new Date(now.getTime() - 36 * 60 * 60 * 1000),
    });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId: seeded.companyId,
      title: "Cancelled blocker",
      status: "cancelled",
      priority: "high",
      issueNumber: 100,
      identifier: `${seeded.issuePrefix}-100`,
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 12 * 60 * 60 * 1000),
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      issueId: blockerIssueId,
      relatedIssueId: seeded.issueId,
      type: "blocks",
      createdAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("creates a high-churn review even when every sampled run has a progress comment", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
      withRunComments: true,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(1);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.description).toContain("Primary trigger: `high_churn`");
    expect(review?.description).toContain("Runs in rolling windows: 10/1h");
  });

  it("ignores non-assignee comments when evaluating high-churn productivity reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 9,
      now,
    });
    const managerRuns = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.managerId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    await db.insert(issueComments).values(
      managerRuns.map((run, index) => ({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorAgentId: seeded.managerId,
        createdByRunId: run.id,
        body: `Manager note ${index}`,
        createdAt: run.createdAt as Date,
        updatedAt: run.createdAt as Date,
      })),
    );

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(0);
  });

  it("skips productivity-review descendants so reviews cannot recursively spawn reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const reviewId = randomUUID();
    const childId = randomUUID();
    await db.insert(issues).values({
      id: reviewId,
      companyId: seeded.companyId,
      title: "Existing productivity review",
      status: "todo",
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
    });
    await db.insert(issues).values({
      id: childId,
      companyId: seeded.companyId,
      title: "Review follow-up child",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: seeded.coderId,
      parentId: reviewId,
      issueNumber: 3,
      identifier: `${seeded.issuePrefix}-3`,
      startedAt: new Date(now.getTime() - 7 * 60 * 60 * 1000),
    });
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: childId,
      count: 10,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.created).toBe(0);
    expect(reviews).toHaveLength(1);
  });

  it("treats a recently completed review as a snooze window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "done", updatedAt: now })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.snoozed).toBe(1);
    expect(reviews).toHaveLength(1);
  });

  it("treats a recently cancelled review as a snooze window", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);
    await db
      .update(issues)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(issues.id, review!.id));

    const result = await service.reconcileProductivityReviews({
      now: new Date(now.getTime() + 30 * 60 * 1000),
      companyId: seeded.companyId,
    });
    const reviews = await listProductivityReviews(seeded.companyId);

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
    expect(reviews).toHaveLength(1);
  });

  async function seedTerminalReview(
    seeded: Awaited<ReturnType<typeof seedAssignedIssue>>,
    opts: { status: "done" | "cancelled"; createdAt: Date; updatedAt: Date },
  ) {
    await db.insert(issues).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      title: "Prior productivity review",
      status: opts.status,
      priority: "high",
      originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
      originId: seeded.issueId,
      originFingerprint: `productivity-review:${seeded.issueId}`,
      parentId: seeded.issueId,
      issueNumber: 2,
      identifier: `${seeded.issuePrefix}-2`,
      createdAt: opts.createdAt,
      updatedAt: opts.updatedAt,
    });
  }

  it("suppresses re-creation for a full 24h after the prior review closes as done", async () => {
    // Regression for the OWN-139 -> OWN-146 double fire: the prior review was
    // created 24h0m11s before the tick (escaping the created_at creation cap by
    // 11 seconds) and closed 23h47m before the tick. The default resolved-review
    // snooze must cover the whole first 24h after close.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(seeded, {
      status: "done",
      createdAt: new Date(now.getTime() - (24 * 60 * 60 * 1000 + 11_000)),
      updatedAt: new Date(now.getTime() - (23 * 60 * 60 * 1000 + 47 * 60 * 1000)),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("suppresses re-creation for a full 24h after the prior review is cancelled", async () => {
    // Regression for the OWN-144 -> OWN-145 double fire: the prior review was
    // cancelled 6h0m6s before the tick, just past the old 6h snooze, and
    // cancelled reviews never count toward the creation cap, so a duplicate
    // fired on the first eligible tick. Cancellation must suppress for 24h too.
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(seeded, {
      status: "cancelled",
      createdAt: new Date(now.getTime() - (19 * 60 * 60 * 1000 + 28 * 60 * 1000)),
      updatedAt: new Date(now.getTime() - (6 * 60 * 60 * 1000 + 6_000)),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("keeps suppressing near the far edge of the 24h window after a cancellation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(seeded, {
      status: "cancelled",
      createdAt: new Date(now.getTime() - (23 * 60 * 60 * 1000 + 30 * 60 * 1000)),
      updatedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("creates a new review once the prior close is older than 24h", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(seeded, {
      status: "done",
      createdAt: new Date(now.getTime() - 26 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(0);
    expect(result.created).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(2);
  });

  it("honors a per-call resolvedSnoozeMs override below the 24h default", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    // Created outside the 24h creation cap so only the snooze override decides.
    await seedTerminalReview(seeded, {
      status: "done",
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
      thresholds: { resolvedSnoozeMs: 60 * 60 * 1000 },
    });

    expect(result.snoozed).toBe(0);
    expect(result.created).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(2);
  });

  it("reports and logs soft-stop holds for open no-comment reviews", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();
    const [latestRun] = await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: 10,
      now,
    });
    const service = productivityReviewService(db);
    await service.reconcileProductivityReviews({ now, companyId: seeded.companyId });
    const [review] = await listProductivityReviews(seeded.companyId);

    const hold = await service.isProductivityReviewContinuationHoldActive({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      agentId: seeded.coderId,
      now,
    });
    expect(hold.held).toBe(true);
    if (!hold.held) return;

    await service.recordContinuationHold({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: latestRun!.id as string,
      agentId: seeded.coderId,
      reviewIssueId: review!.id,
      trigger: hold.trigger,
      reason: hold.reason,
    });
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.productivity_review_continuation_held"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.entityId).toBe(seeded.issueId);
  });

  it("suppresses re-creation using the company-configured snooze when set", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await db
      .update(companies)
      .set({ productivityReviewResolvedSnoozeMs: 4 * 60 * 60 * 1000 })
      .where(eq(companies.id, seeded.companyId));

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(seeded, {
      status: "done",
      createdAt: new Date(now.getTime() - (25 * 60 * 60 * 1000)),
      updatedAt: new Date(now.getTime() - (2 * 60 * 60 * 1000)),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("creates a new review once the company-configured snooze window expires", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await db
      .update(companies)
      .set({ productivityReviewResolvedSnoozeMs: 60 * 60 * 1000 })
      .where(eq(companies.id, seeded.companyId));

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(seeded, {
      status: "done",
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(0);
    expect(result.created).toBe(1);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(2);
  });

  it("uses the global 24h default when no company-specific snooze is configured", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(seeded, {
      status: "done",
      createdAt: new Date(now.getTime() - (24 * 60 * 60 * 1000 + 11_000)),
      updatedAt: new Date(now.getTime() - (23 * 60 * 60 * 1000 + 47 * 60 * 1000)),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(0);
    expect(await listProductivityReviews(seeded.companyId)).toHaveLength(1);
  });

  it("two companies with different snooze settings each respect their own", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");

    const customSeeded = await seedAssignedIssue();
    await db
      .update(companies)
      .set({ productivityReviewResolvedSnoozeMs: 1 * 60 * 60 * 1000 })
      .where(eq(companies.id, customSeeded.companyId));
    await insertRuns({
      companyId: customSeeded.companyId,
      agentId: customSeeded.coderId,
      issueId: customSeeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(customSeeded, {
      status: "done",
      createdAt: new Date(now.getTime() - (25 * 60 * 60 * 1000)),
      updatedAt: new Date(now.getTime() - (2 * 60 * 60 * 1000)),
    });

    const defaultSeeded = await seedAssignedIssue();
    await insertRuns({
      companyId: defaultSeeded.companyId,
      agentId: defaultSeeded.coderId,
      issueId: defaultSeeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });
    await seedTerminalReview(defaultSeeded, {
      status: "done",
      createdAt: new Date(now.getTime() - (2 * 60 * 60 * 1000)),
      updatedAt: new Date(now.getTime() - (30 * 60 * 1000)),
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({ now });

    expect(result.scanned).toBe(2);
    expect(result.snoozed).toBe(1);
    expect(result.created).toBe(1);

    const customReviews = await listProductivityReviews(customSeeded.companyId);
    expect(customReviews).toHaveLength(2);

    const defaultReviews = await listProductivityReviews(defaultSeeded.companyId);
    expect(defaultReviews).toHaveLength(1);
  });

  it("clamps poisoned requestDepth metadata instead of aborting productivity reconciliation", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    const seeded = await seedAssignedIssue();

    await db
      .update(issues)
      .set({ requestDepth: 2_147_483_647 })
      .where(eq(issues.id, seeded.issueId));

    await insertRuns({
      companyId: seeded.companyId,
      agentId: seeded.coderId,
      issueId: seeded.issueId,
      count: DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      now,
    });

    const result = await productivityReviewService(db).reconcileProductivityReviews({
      now,
      companyId: seeded.companyId,
    });

    expect(result.failed).toBe(0);
    const [review] = await listProductivityReviews(seeded.companyId);
    expect(review?.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });
});
