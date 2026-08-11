import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  decisionEffectExecutions,
  decisionRetention,
  decisions,
  decisionTargetIssues,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";
import { decisionService } from "../services/decisions.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import {
  decisionEffectRequiredCapability,
  decisionEffectTargetIssueIds,
  type AttentionArchiveManifestEntry,
  type AttentionArchiveTargetSnapshot,
  type DecisionAuthorityGrantV1,
  type DecisionOption,
  type DecisionTechnicalEvidenceV1,
  type ExternalEnforcementEvidenceV1,
} from "@paperclipai/shared";
import { signDecisionSpec } from "../services/decision-signing.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("decisionService", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let originIssueId: string;
  let targetIssueId: string;
  let runId: string;
  let originResponsibleUserId: string;
  let decidedByUserId: string;
  let otherBoardUserId: string;
  let wakes: Array<Record<string, unknown>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decisions-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    companyId = randomUUID(); agentId = randomUUID(); originIssueId = randomUUID(); targetIssueId = randomUUID(); runId = randomUUID();
    originResponsibleUserId = `origin-${randomUUID()}`;
    decidedByUserId = originResponsibleUserId;
    otherBoardUserId = `other-${randomUUID()}`;
    wakes = [];
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Decisions", issuePrefix: `D${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values([
      { id: originResponsibleUserId, name: "Origin", email: `${originResponsibleUserId}@example.test`, createdAt: now, updatedAt: now },
      { id: otherBoardUserId, name: "Other", email: `${otherBoardUserId}@example.test`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: originResponsibleUserId, status: "active", membershipRole: "member" },
      { companyId, principalType: "user", principalId: otherBoardUserId, status: "active", membershipRole: "member" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Proposer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { id: originIssueId, companyId, title: "Origin", status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: originResponsibleUserId },
      { id: targetIssueId, companyId, title: "Target", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: originResponsibleUserId, contextSnapshot: { issueId: originIssueId } });
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE;
    delete process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions); await db.delete(decisionRetention); await db.delete(activityLog);
    await db.delete(issueComments); await db.delete(issueRelations); await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  const agentActor = () => ({ type: "agent" as const, companyId, agentId, runId, source: "agent_jwt" as const,
    onBehalfOfUserId: originResponsibleUserId, onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const boardActor = () => ({ type: "board" as const, userId: decidedByUserId, companyIds: [companyId], source: "session" as const,
    memberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const authorityFor = (options: DecisionOption[]): DecisionAuthorityGrantV1 => {
    const targetIssueIds = [...new Set(options.flatMap((option) => option.effects.flatMap(decisionEffectTargetIssueIds)))];
    const capabilities = [...new Set(options.flatMap((option) => option.effects
      .map(decisionEffectRequiredCapability)
      .filter((capability): capability is NonNullable<typeof capability> => capability !== null)))];
    return capabilities.length === 0
      ? {
        schemaVersion: 1,
        authorityClass: "design_approval",
        issuer: { userId: decidedByUserId, source: { kind: "issue", id: originIssueId }, issuedAt: new Date(Date.now() - 1_000).toISOString() },
        actor: { kind: "agent", id: agentId },
        targetIssueIds,
        capabilities: [],
        expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        requiredExternalGates: [],
      }
      : {
        schemaVersion: 1,
        authorityClass: "execution_authority",
        issuer: { userId: decidedByUserId, source: { kind: "issue", id: originIssueId }, issuedAt: new Date(Date.now() - 1_000).toISOString() },
        actor: { kind: "agent", id: agentId },
        targetIssueIds,
        capabilities,
        expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        requiredExternalGates: [],
      };
  };
  const service = () => {
    const inner = decisionService(db, { wakeOriginAgent: async (input) => { wakes.push(input); } });
    type CreateInput = Parameters<typeof inner.create>[0];
    type CreateBundleInput = Parameters<typeof inner.createBundle>[0];
    return {
      ...inner,
      create: (input: CreateInput, dbOrTx?: Parameters<typeof inner.create>[1]) =>
        inner.create({ ...input, authority: input.authority ?? authorityFor(input.options) }, dbOrTx),
      createBundle: (input: CreateBundleInput) => inner.createBundle({
        ...input,
        decisions: input.decisions.map((item) => ({ ...item, authority: item.authority ?? authorityFor(item.options) })),
      }),
    };
  };
  const createCommentDecision = (staleness: "strict" | "lenient" = "lenient", extra: Record<string, unknown> = {}) => service().create({
    companyId, actor: agentActor(), agentId, runId, title: "Comment?", body: "Body", continuationPolicy: "wake_origin_agent",
    options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue", targetIssueId, staleness, bodyMarkdown: "hello" }] }],
    ...extra,
  });

  // Make an existing decision TTL-expired for the next sweep. Creating a
  // decision that is already expired is impossible (create rejects a past
  // expiresAt), and creating one that expires a few milliseconds later races
  // the service's own clock read — under CI load the create itself can fail
  // with "expiresAt must be within 30 days". Create with a comfortable future
  // expiry instead, then move expiresAt into the past directly in the store.
  const nearFutureExpiry = () => new Date(Date.now() + 60_000);
  const expireDecisionNow = (id: string) =>
    db.update(decisions).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, id));

  const evidencePair = () => {
    const headSha = "a".repeat(40);
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const evaluatedAt = new Date(Date.now() - 30_000).toISOString();
    const technicalEvidence: DecisionTechnicalEvidenceV1 = {
      schemaVersion: 1,
      provider: "github",
      repository: { id: "repository-1", owner: "paperclipai", name: "paperclip" },
      pullRequest: { number: 321, baseSha: "b".repeat(40), headSha, mergeCommitSha: null, mergedAt: null },
      fingerprints: {
        environment: `sha256:${"1".repeat(64)}`,
        configuration: `sha256:${"2".repeat(64)}`,
        branchRules: `sha256:${"3".repeat(64)}`,
      },
      observedAt,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      requiredChecks: [{ runId: "check-1", name: "test", appId: 42, conclusion: "success", commitSha: headSha }],
      reviews: [{ id: "review-1", actor: "maintainer", state: "approved", commitSha: headSha, submittedAt: observedAt }],
    };
    const gates: ExternalEnforcementEvidenceV1["gates"] = [
      "github_actor",
      "codeowners_review",
      "branch_protection",
      "required_checks",
      "exact_head",
      "merge_gate",
    ].map((type) => ({
      type: type as ExternalEnforcementEvidenceV1["gates"][number]["type"],
      status: "passed" as const,
      evidenceIds: [`github:${type}:proof`],
    }));
    const externalEnforcement: ExternalEnforcementEvidenceV1 = {
      schemaVersion: 1,
      provider: "github",
      repositoryId: technicalEvidence.repository.id,
      pullRequestNumber: technicalEvidence.pullRequest.number,
      actor: "maintainer",
      headSha,
      evaluatedAt,
      allowed: true,
      gates,
    };
    return { technicalEvidence, externalEnforcement };
  };

  it("returns the existing decision for concurrent idempotent creates", async () => {
    const options: DecisionOption[] = [{ id: "yes", label: "Yes", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "hello",
    }] }];
    const input = {
      companyId, actor: agentActor(), agentId, runId, title: "Same?", body: "Body", idempotencyKey: "concurrent-create",
      options,
      // An idempotency retry must replay the exact signed authority bytes.
      authority: authorityFor(options),
    };
    const [first, second] = await Promise.all([service().create(input), service().create(input)]);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(decisions).where(eq(decisions.idempotencyKey, "concurrent-create"))).toHaveLength(1);
  });

  it("allows only a signed, selected parent authority subset for decision-sourced grants", async () => {
    const options: DecisionOption[] = [{ id: "yes", label: "Yes", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "follow-up",
    }] }];
    const parent = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Parent grant?", body: "Body", options,
    });
    await service().decide({ id: parent.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    const sourceAuthority: DecisionAuthorityGrantV1 = {
      ...parent.authority!,
      issuer: { ...parent.authority!.issuer, source: { kind: "decision", id: parent.id } },
    };

    await expect(service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Constrained follow up?", body: "Body", options,
      authority: sourceAuthority,
    })).resolves.toMatchObject({
      authority: expect.objectContaining({
        targetIssueIds: parent.authority!.targetIssueIds,
        capabilities: parent.authority!.capabilities,
      }),
    });

    await expect(service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Missing parent?", body: "Body", options,
      authority: { ...sourceAuthority, issuer: { ...sourceAuthority.issuer, source: { kind: "decision", id: randomUUID() } } },
    })).rejects.toThrow("must be a valid subset");

    const openParent = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Open parent?", body: "Body", options,
    });
    await expect(service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Unselected child?", body: "Body", options,
      authority: { ...sourceAuthority, issuer: { ...sourceAuthority.issuer, source: { kind: "decision", id: openParent.id } } },
    })).rejects.toThrow("must be a valid subset");

    await expect(service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Expired widening?", body: "Body", options,
      authority: { ...sourceAuthority, expiresAt: new Date(Date.parse(sourceAuthority.expiresAt) + 1_000).toISOString() },
    })).rejects.toThrow("must be a valid subset");

    await db.update(decisions).set({ title: "Tampered parent" }).where(eq(decisions.id, parent.id));
    // Title is intentionally not part of the execution signature; mutate the
    // signed options to prove parent HMAC validation gates delegation.
    await db.update(decisions).set({ options: [{ id: "tampered", label: "Tampered", effects: [] }] }).where(eq(decisions.id, parent.id));
    await expect(service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Tampered child?", body: "Body", options, authority: sourceAuthority,
    })).rejects.toThrow("must be a valid subset");
  });

  it("does not let a delegated child shed a parent authority gate", async () => {
    const options: DecisionOption[] = [{ id: "yes", label: "Yes", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "gated",
    }] }];
    const evidence = evidencePair();
    const gatedAuthority: DecisionAuthorityGrantV1 = {
      ...authorityFor(options),
      authorityClass: "execution_authority",
      targetIssueIds: [targetIssueId],
      capabilities: ["implementation"],
      requiredExternalGates: ["github_actor"],
    };
    const gatedService = decisionService(db, {
      wakeOriginAgent: async () => undefined,
      loadDecisionEvidence: async () => structuredClone(evidence),
    });
    const parent = await gatedService.create({
      companyId, actor: agentActor(), agentId, runId, title: "Gated parent?", body: "Body",
      options, authority: gatedAuthority, ...evidence,
    });
    await gatedService.decide({ id: parent.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    await expect(gatedService.create({
      companyId, actor: agentActor(), agentId, runId, title: "Weakened child?", body: "Body",
      options,
      authority: {
        ...parent.authority!,
        issuer: { ...parent.authority!.issuer, source: { kind: "decision", id: parent.id } },
        requiredExternalGates: [],
      },
      ...evidence,
    })).rejects.toThrow("must be a valid subset");
  });

  it("rejects an authority issuer that differs from the authenticated origin-run user", async () => {
    const options: DecisionOption[] = [{ id: "yes", label: "Yes", effects: [] }];
    const authority = authorityFor(options);
    await expect(service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Forged issuer?", body: "Body", options,
      authority: { ...authority, issuer: { ...authority.issuer, userId: otherBoardUserId } },
    })).rejects.toThrow("issuer and actor must match authenticated origin provenance");
  });

  it("executes once, replays stored outcome, and attributes executor audit to the decider", async () => {
    const created = await createCommentDecision();
    const first = await service().decide({ id: created.id, optionId: "yes", idempotencyKey: "decide-1", decidedByUserId, userActor: boardActor() });
    const replay = await service().decide({ id: created.id, optionId: "yes", idempotencyKey: "decide-1", decidedByUserId, userActor: boardActor() });
    expect(first.executionStatus).toBe("succeeded"); expect(replay.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.effect_executed"));
    expect(audit[0]?.responsibleUserId).toBe(decidedByUserId);
    expect(audit[0]?.details).toMatchObject({ decidedByUserId, originResponsibleUserId });
    expect(first.executions[0]?.activityLogId).toBe(audit[0]?.id);
    expect(wakes).toHaveLength(1);
  });

  it("allows one double-decide winner and rejects the loser", async () => {
    const created = await createCommentDecision();
    const outcomes = await Promise.allSettled([
      service().decide({ id: created.id, optionId: "yes", idempotencyKey: "race-a", decidedByUserId, userActor: boardActor() }),
      service().decide({ id: created.id, optionId: "yes", idempotencyKey: "race-b", decidedByUserId, userActor: boardActor() }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("binds bulk archive acceptance to the exact signed, versioned manifest", async () => {
    const extraIssueId = randomUUID();
    const unreviewedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: extraIssueId, companyId, title: "Second aging item", status: "in_review", priority: "medium", createdByAgentId: agentId, assigneeUserId: decidedByUserId },
      { id: unreviewedIssueId, companyId, title: "Not reviewed", status: "in_review", priority: "medium", createdByAgentId: agentId, assigneeUserId: decidedByUserId },
    ]);
    const activityAt = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(decisionRetention).values([targetIssueId, extraIssueId, unreviewedIssueId].map((sourceId) => ({
      companyId,
      sourceKind: "review",
      sourceId,
      sourceActivityAt: activityAt,
    })));
    const manifest: AttentionArchiveManifestEntry[] = [targetIssueId, extraIssueId].map((sourceId) => ({
      companyId,
      sourceKind: "review",
      sourceId,
      linkedIssueId: sourceId,
      expectedVersion: 1,
      activityAt: activityAt.toISOString(),
      reason: `Archive ${sourceId}`,
    }));
    const snapshots = Object.fromEntries(manifest.map((entry) => [
      `attention:${entry.sourceKind}:${entry.sourceId}`,
      {
        status: "attention",
        assigneeAgentId: null,
        assigneeUserId: null,
        updatedAt: entry.activityAt,
        attentionArchive: entry,
      } satisfies AttentionArchiveTargetSnapshot,
    ]));
    const options: DecisionOption[] = [
      { id: "archive", label: "Archive", style: "destructive", effects: [] },
      { id: "keep", label: "Keep", effects: [] },
    ];
    const archiveInput = {
      companyId,
      actor: agentActor(),
      agentId,
      runId,
      title: "Archive two?",
      body: "Reviewed exact set",
      options,
      idempotencyKey: "archive-two-exact-manifest",
      metadata: { kind: "attention_archive_proposal", manifestHash: hashAttentionArchiveManifest(manifest) },
      additionalTargetSnapshots: snapshots,
    };
    const rawService = decisionService(db, { wakeOriginAgent: async (input) => { wakes.push(input); } });

    await expect(rawService.create({
      ...archiveInput,
      authority: authorityFor(options),
      idempotencyKey: "archive-design-authority-denied",
    })).rejects.toThrow("Attention archive proposals require delivery authority over every linked issue target");
    expect((await db.select().from(decisionRetention)).every((row) => row.archivedAt === null)).toBe(true);

    const expired = await rawService.create({
      ...archiveInput,
      idempotencyKey: "archive-expired-recovery",
    });
    const expiredAuthority: DecisionAuthorityGrantV1 = {
      ...expired.authority!,
      issuer: {
        ...expired.authority!.issuer,
        issuedAt: new Date(Date.now() - 120_000).toISOString(),
      },
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await db.update(decisions).set({
      status: "decided",
      executionStatus: "running",
      chosenOptionId: "archive",
      decidedByUserId: originResponsibleUserId,
      decidedAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
      authority: expiredAuthority,
      signedSpec: signDecisionSpec({
        decisionId: expired.id,
        authority: expiredAuthority,
        technicalEvidence: expired.technicalEvidence,
        externalEnforcement: expired.externalEnforcement,
        options: expired.options,
        inputs: expired.inputs,
        targetSnapshots: expired.targetSnapshots,
      }),
    }).where(eq(decisions.id, expired.id));
    process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS = "0";
    await rawService.sweepExpired();
    expect(await rawService.outcome(expired.id)).toMatchObject({
      executionStatus: "blocked",
      metadata: {
        archiveProposalError: "deny_decision_authority",
        governanceBlockedReason: "deny_decision_authority",
        authorityReason: "authority_expired",
      },
    });
    expect((await db.select().from(decisionRetention)).every((row) => row.archivedAt === null)).toBe(true);

    const created = await rawService.create(archiveInput);
    const replay = await rawService.create(archiveInput);
    expect(replay.id).toBe(created.id);
    expect(created.authority).toMatchObject({
      authorityClass: "execution_authority",
      capabilities: ["delivery"],
      targetIssueIds: expect.arrayContaining([targetIssueId, extraIssueId]),
    });
    expect(created.authority?.targetIssueIds).toHaveLength(2);

    const result = await rawService.decide({
      id: created.id,
      optionId: "archive",
      decidedByUserId: originResponsibleUserId,
      userActor: {
        ...boardActor(),
        userId: originResponsibleUserId,
      },
    });
    expect(result.executionStatus).toBe("succeeded");
    const states = await db.select().from(decisionRetention);
    expect(states.filter((row) => row.archivedAt).map((row) => row.sourceId).sort()).toEqual([extraIssueId, targetIssueId].sort());
    expect(states.find((row) => row.sourceId === unreviewedIssueId)?.archivedAt).toBeNull();
  });

  it("skips strict stale targets and fails closed on intersection denial", async () => {
    const stale = await createCommentDecision("strict");
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, targetIssueId));
    const staleResult = await service().decide({ id: stale.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(staleResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });

    const denied = await createCommentDecision("lenient", { idempotencyKey: "denied" });
    const deniedResult = await service().decide({ id: denied.id, optionId: "yes", decidedByUserId,
      userActor: { type: "board", userId: decidedByUserId, companyIds: [], memberships: [], source: "session" } });
    expect(deniedResult.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
    const failedAudit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.effect_failed"));
    expect(failedAudit.at(-1)?.details).toMatchObject({ reason: "deny_decision_intersection" });
  });

  it("preserves effect-time governance denial evidence through terminal status and continuation delivery", async () => {
    const options: DecisionOption[] = [{ id: "yes", label: "Yes", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "must not run",
    }] }];
    const authority: DecisionAuthorityGrantV1 = {
      ...authorityFor(options),
      authorityClass: "execution_authority",
      capabilities: ["delivery"],
      requiredExternalGates: ["required_checks"],
    };
    const signedEvidence = evidencePair();
    const deniedEnforcement = structuredClone(signedEvidence.externalEnforcement);
    deniedEnforcement.allowed = false;
    deniedEnforcement.gates.find((gate) => gate.type === "required_checks")!.status = "failed";
    let evidenceLoadCount = 0;
    const governedService = decisionService(db, {
      wakeOriginAgent: async (input) => { wakes.push(input); },
      loadDecisionEvidence: async () => {
        evidenceLoadCount += 1;
        return {
          technicalEvidence: structuredClone(signedEvidence.technicalEvidence),
          externalEnforcement: evidenceLoadCount === 1
            ? structuredClone(signedEvidence.externalEnforcement)
            : deniedEnforcement,
        };
      },
    });
    const created = await governedService.create({
      companyId, actor: agentActor(), agentId, runId, title: "Ship?", body: "Body",
      continuationPolicy: "wake_origin_agent", options, authority, ...signedEvidence,
    });

    const result = await governedService.decide({
      id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor(),
    });

    expect(result.executionStatus).toBe("blocked");
    expect(result.latestEnforcementResult).toMatchObject({ allowed: false });
    expect(result.metadata).toMatchObject({
      governanceBlockedReason: "external_enforcement_denied",
      governanceBlockedAt: expect.any(String),
      continuationPending: false,
    });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });

  it("retries a blocked continuation after a crash between governance denial and wake delivery", async () => {
    const options: DecisionOption[] = [{ id: "yes", label: "Yes", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "must not run",
    }] }];
    const authority: DecisionAuthorityGrantV1 = {
      ...authorityFor(options),
      authorityClass: "execution_authority",
      capabilities: ["delivery"],
      requiredExternalGates: ["required_checks"],
    };
    const signedEvidence = evidencePair();
    const deniedEnforcement = structuredClone(signedEvidence.externalEnforcement);
    deniedEnforcement.allowed = false;
    deniedEnforcement.gates.find((gate) => gate.type === "required_checks")!.status = "failed";
    let evidenceLoadCount = 0;
    const crashingService = decisionService(db, {
      wakeOriginAgent: async () => { throw new Error("simulated blocked-continuation crash"); },
      loadDecisionEvidence: async () => {
        evidenceLoadCount += 1;
        return {
          technicalEvidence: structuredClone(signedEvidence.technicalEvidence),
          externalEnforcement: evidenceLoadCount === 1
            ? structuredClone(signedEvidence.externalEnforcement)
            : deniedEnforcement,
        };
      },
    });
    const created = await crashingService.create({
      companyId, actor: agentActor(), agentId, runId, title: "Ship?", body: "Body",
      continuationPolicy: "wake_origin_agent", options, authority, ...signedEvidence,
    });

    await expect(crashingService.decide({
      id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor(),
    })).rejects.toThrow("simulated blocked-continuation crash");
    expect(await service().get(created.id)).toMatchObject({
      executionStatus: "blocked",
      metadata: { continuationPending: true },
    });

    await expect(service().sweepExpired()).resolves.toEqual({ expired: 0, resumed: 0 });

    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
    expect((await service().get(created.id))?.metadata).toMatchObject({ continuationPending: false });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
  });

  it("signs the provider-resolved evidence bytes and rejects unavailable provider verification", async () => {
    const options: DecisionOption[] = [{ id: "yes", label: "Yes", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "verified",
    }] }];
    const provider = evidencePair();
    const submitted = structuredClone(provider);
    submitted.technicalEvidence.observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    submitted.externalEnforcement.evaluatedAt = new Date(Date.now() - 4 * 60_000).toISOString();
    submitted.externalEnforcement.gates[0]!.evidenceIds = ["caller:invented-proof"];
    provider.externalEnforcement.gates[0]!.evidenceIds = ["github:user:maintainer"];
    let providerLoads = 0;
    const authority: DecisionAuthorityGrantV1 = {
      ...authorityFor(options),
      authorityClass: "execution_authority",
      targetIssueIds: [targetIssueId],
      capabilities: ["implementation"],
      requiredExternalGates: ["required_checks"],
    };
    const verifiedService = decisionService(db, {
      wakeOriginAgent: async () => undefined,
      loadDecisionEvidence: async () => {
        providerLoads += 1;
        const snapshot = structuredClone(provider);
        if (providerLoads > 1) {
          snapshot.technicalEvidence.observedAt = new Date(Date.parse(snapshot.technicalEvidence.observedAt) + 1_000).toISOString();
          snapshot.externalEnforcement.evaluatedAt = new Date(Date.parse(snapshot.externalEnforcement.evaluatedAt) + 1_000).toISOString();
        }
        return snapshot;
      },
    });

    const createInput = {
      companyId, actor: agentActor(), agentId, runId, title: "Verified evidence?", body: "Body",
      options, authority, idempotencyKey: "verified-evidence-retry", ...submitted,
    };
    const created = await verifiedService.create(createInput);
    const replay = await verifiedService.create(createInput);

    expect(replay.id).toBe(created.id);
    expect(providerLoads).toBe(1);
    expect(await db.select().from(decisions).where(eq(decisions.idempotencyKey, "verified-evidence-retry"))).toHaveLength(1);
    expect(created.technicalEvidence).toEqual(provider.technicalEvidence);
    expect(created.externalEnforcement).toEqual(provider.externalEnforcement);
    expect(created.externalEnforcement).not.toEqual(submitted.externalEnforcement);

    const changedEvidence = structuredClone(submitted);
    changedEvidence.externalEnforcement.gates[0]!.evidenceIds = ["caller:changed-proof"];
    await expect(verifiedService.create({ ...createInput, ...changedEvidence }))
      .rejects.toThrow("Decision idempotency key already used with a different payload");
    expect(providerLoads).toBe(1);

    await expect(decisionService(db, { wakeOriginAgent: async () => undefined }).create({
      companyId, actor: agentActor(), agentId, runId, title: "Unavailable evidence?", body: "Body",
      options, authority, ...submitted,
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ reason: "evidence_unavailable" }),
    });
  });

  it("does not let a different authenticated session ride the signed issuer identity", async () => {
    const created = await createCommentDecision();
    await expect(service().decide({
      id: created.id,
      optionId: "yes",
      decidedByUserId,
      userActor: { ...boardActor(), userId: otherBoardUserId },
    })).rejects.toThrow("does not own the authority issuer identity");
    expect((await service().get(created.id))?.status).toBe("open");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
  });

  it("fails closed when the origin actor retains read access but loses mutation access", async () => {
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Update?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress" }] }],
    });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
  });

  it("removes inbound blockers without replacing them with outgoing relations", async () => {
    const removedBlockerId = randomUUID();
    const retainedBlockerId = randomUUID();
    const downstreamId = randomUUID();
    await db.insert(issues).values([
      { id: removedBlockerId, companyId, title: "Removed blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
      { id: retainedBlockerId, companyId, title: "Retained blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
      { id: downstreamId, companyId, title: "Downstream", status: "todo", priority: "medium", responsibleUserId: decidedByUserId },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: removedBlockerId, relatedIssueId: targetIssueId, type: "blocks" },
      { companyId, issueId: retainedBlockerId, relatedIssueId: targetIssueId, type: "blocks" },
      { companyId, issueId: targetIssueId, relatedIssueId: downstreamId, type: "blocks" },
    ]);
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Resolve blocker?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "resolve_blocker", targetIssueId, staleness: "lenient",
        removeBlockedByIssueIds: [removedBlockerId] }] }],
    });

    await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    const relations = await db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId));
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: retainedBlockerId, relatedIssueId: targetIssueId, type: "blocks" }),
      expect.objectContaining({ issueId: targetIssueId, relatedIssueId: downstreamId, type: "blocks" }),
    ]));
    expect(relations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: removedBlockerId, relatedIssueId: targetIssueId, type: "blocks" }),
    ]));
  });

  it("rejects mutation proposals from an origin actor with read-only access", async () => {
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const readOnlyActor = { ...agentActor(),
      onBehalfOfMemberships: [{ companyId, membershipRole: "viewer" as const, status: "active" as const }] };

    await expect(service().create({
      companyId, actor: readOnlyActor, agentId, runId, title: "Update?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{
        type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress",
      }] }],
    })).rejects.toThrow("Decision effect exceeds the origin authority boundary");
  });

  it("expires a decision atomically instead of executing after its deadline", async () => {
    const created = await createCommentDecision("lenient");
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(decisions.id, created.id));
    await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
      .rejects.toThrow("decision_expired");
    expect((await service().get(created.id))?.status).toBe("expired");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
  });

  it("rejects strict effects when secondary targets or cancellation scope change", async () => {
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium", responsibleUserId: decidedByUserId });
    const createDecision = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Create?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "create_issue", targetIssueId, staleness: "strict", draft: { title: "Follow-up", blockedByIssueIds: [blockerId] } }] }],
    });
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, blockerId));
    const createResult = await service().decide({ id: createDecision.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(createResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });

    const cancelDecision = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel?", body: "Body",
      options: [{ id: "yes", label: "Yes", style: "destructive", effects: [{ type: "cancel_issue_tree", targetIssueId, staleness: "strict", reasonComment: "cleanup" }] }],
    });
    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId, title: "New child", status: "todo", priority: "medium", parentId: targetIssueId, responsibleUserId: decidedByUserId });
    const cancelResult = await service().decide({ id: cancelDecision.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(cancelResult.executions[0]).toMatchObject({ status: "skipped", error: "target_changed" });
    expect((await db.select().from(issues).where(eq(issues.id, childId)))[0]?.status).toBe("todo");
  });

  it("rejects lenient cancellation before signing", async () => {
    const reviewedChildId = randomUUID();
    await db.insert(issues).values({ id: reviewedChildId, companyId, title: "Reviewed child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });
    await expect(service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel?", body: "Body",
      options: [{ id: "yes", label: "Yes", style: "destructive", effects: [{
        type: "cancel_issue_tree", targetIssueId, staleness: "lenient", reasonComment: "cleanup",
      }] }],
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "invalid_decision_governance" }),
    });
  });

  it("bounds cyclic issue traversal for snapshots and cancel-tree execution", async () => {
    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId, title: "Cycle child", status: "todo", priority: "medium",
      parentId: targetIssueId, responsibleUserId: decidedByUserId });
    await db.update(issues).set({ parentId: childId }).where(eq(issues.id, targetIssueId));
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Cancel cycle?", body: "Body",
      options: [{ id: "cancel", label: "Cancel", style: "destructive", effects: [{
        type: "cancel_issue_tree", targetIssueId, staleness: "strict", reasonComment: "cleanup",
      }] }],
    });

    expect((created.targetSnapshots as Record<string, { descendantCount: number }>)[targetIssueId]?.descendantCount).toBe(1);
    const result = await service().decide({ id: created.id, optionId: "cancel", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "executed", result: { cancelledIssueIds: [childId, targetIssueId] } });
    expect(await db.select({ id: issues.id, status: issues.status }).from(issues).where(eq(issues.companyId, companyId)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: targetIssueId, status: "cancelled" }),
        expect.objectContaining({ id: childId, status: "cancelled" }),
      ]));
  });

  it("fails closed when the deciding user lacks assignment capability", async () => {
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({ id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Assign?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [{ type: "assign_issue", targetIssueId, staleness: "lenient", assigneeAgentId }] }],
    });
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, decidedByUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
  });

  it("fails closed when the origin responsible user loses visibility", async () => {
    const created = await createCommentDecision();
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, originResponsibleUserId));
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executions[0]).toMatchObject({ status: "failed", error: "deny_decision_intersection" });
    expect(result.executions[0]?.result).toMatchObject({ originReason: "deny_missing_membership" });
  });

  it("fails closed when the configured signing secret is removed after proposal", async () => {
    const created = await createCommentDecision();
    const originalHome = process.env.PAPERCLIP_HOME;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-rotate-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "agent-jwt-secret-must-not-sign-decisions";
    try {
      await expect(service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
        .rejects.toThrow("Decision signature verification failed");
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps pre-governance rows read-only except for authenticated safe dismissal", async () => {
    const created = await createCommentDecision();
    const legacySignature = signDecisionSpec({
      decisionId: created.id,
      options: created.options,
      targetSnapshots: created.targetSnapshots,
    });
    await db.update(decisions).set({
      authority: null,
      technicalEvidence: null,
      externalEnforcement: null,
      signedSpec: legacySignature,
    }).where(eq(decisions.id, created.id));

    await expect(service().decide({
      id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor(),
    })).rejects.toThrow("Decision has invalid or legacy read-only authority");
    const dismissed = await service().dismiss(created.id, decidedByUserId, boardActor(), "No");
    expect(dismissed).toMatchObject({
      status: "decided",
      executionStatus: "succeeded",
      chosenOptionId: "dismissed",
      metadata: { dismissed: true, dismissReason: "No" },
    });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    expect(await db.select().from(decisionEffectExecutions).where(eq(decisionEffectExecutions.decisionId, created.id))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed")))
      .toEqual([expect.objectContaining({ entityId: created.id, responsibleUserId: decidedByUserId })]);
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });

  it("signs and verifies with an auto-generated key when no secret is configured", async () => {
    const originalHome = process.env.PAPERCLIP_HOME;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-generated-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      const created = await createCommentDecision();
      const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
      expect(result.executionStatus).toBe("succeeded");
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("records a failed effect and continues independent later effects", async () => {
    const created = await service().create({
      companyId, actor: agentActor(), agentId, runId, title: "Continue?", body: "Body",
      options: [{ id: "yes", label: "Yes", effects: [
        { type: "update_issue_status", targetIssueId, staleness: "lenient", status: "in_progress" },
        { type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "still runs" },
      ] }],
    });
    const result = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(result.executionStatus).toBe("partial");
    expect(result.executions).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectIndex: 0, status: "failed", error: "effect_execution_failed" }),
      expect.objectContaining({ effectIndex: 1, status: "executed" }),
    ]));
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("resumes claimed effects exactly once after a simulated crash without a client idempotency key", async () => {
    const created = await createCommentDecision();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId,
      inputValues: {} }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({ decisionId: created.id, effectIndex: 0, effectType: "comment_on_issue", targetIssueId, status: "claimed" });
    const resumed = await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });
    expect(resumed.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("recovers stale running decisions from the bounded server sweep", async () => {
    process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS = "0";
    const created = await createCommentDecision();
    await db.update(decisions).set({ status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId,
      inputValues: {}, updatedAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({ decisionId: created.id, effectIndex: 0, effectType: "comment_on_issue",
      targetIssueId, status: "claimed" });

    expect(await service().sweepExpired()).toEqual({ expired: 0, resumed: 1 });
    expect((await service().get(created.id))?.executionStatus).toBe("succeeded");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });

  it("audits and wakes exactly once when a direct decision attempt finds expired authority", async () => {
    const created = await createCommentDecision();
    const expiredAuthority: DecisionAuthorityGrantV1 = {
      ...created.authority!,
      issuer: {
        ...created.authority!.issuer,
        issuedAt: new Date(Date.now() - 120_000).toISOString(),
      },
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await db.update(decisions).set({
      authority: expiredAuthority,
      expiresAt: new Date(Date.now() - 30_000),
      signedSpec: signDecisionSpec({
        decisionId: created.id,
        authority: expiredAuthority,
        technicalEvidence: created.technicalEvidence,
        externalEnforcement: created.externalEnforcement,
        options: created.options,
        inputs: created.inputs,
        targetSnapshots: created.targetSnapshots,
      }),
    }).where(eq(decisions.id, created.id));

    await expect(service().decide({
      id: created.id,
      optionId: "yes",
      decidedByUserId,
      userActor: boardActor(),
    })).rejects.toThrow("decision_authority_expired");

    expect(await service().get(created.id)).toMatchObject({
      status: "expired",
      metadata: {
        expiredReason: "authority_expired",
        authorityReason: "authority_expired",
        governanceBlockedReason: "deny_decision_authority",
        governanceBlockedAt: expect.any(String),
        continuationPending: false,
      },
    });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    expect(await db.select().from(decisionEffectExecutions).where(eq(decisionEffectExecutions.decisionId, created.id)))
      .toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.expired")))
      .toEqual([expect.objectContaining({
        entityId: created.id,
        details: expect.objectContaining({
          expiredReason: "authority_expired",
        }),
      })]);
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "expired" }]);

    expect(await service().sweepExpired()).toEqual({ expired: 0, resumed: 0 });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.expired"))).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });

  it("fails closed when recovery encounters a tampered signed decision", async () => {
    process.env.PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS = "0";
    const created = await createCommentDecision();
    await db.update(decisions).set({
      status: "decided",
      executionStatus: "running",
      chosenOptionId: "yes",
      decidedByUserId,
      inputValues: {},
      authority: { ...created.authority!, expiresAt: new Date(Date.now() + 13 * 86_400_000).toISOString() },
      updatedAt: new Date(Date.now() - 1_000),
    }).where(eq(decisions.id, created.id));
    await db.insert(decisionEffectExecutions).values({
      decisionId: created.id,
      effectIndex: 0,
      effectType: "comment_on_issue",
      targetIssueId,
      status: "claimed",
    });

    await expect(service().sweepExpired()).resolves.toEqual({ expired: 0, resumed: 1 });

    const recovered = await service().get(created.id);
    expect(recovered).toMatchObject({ executionStatus: "blocked" });
    expect(recovered?.metadata).toMatchObject({
      governanceBlockedReason: "deny_decision_signature",
      continuationPending: false,
    });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(0);
    expect(await db.select().from(decisionEffectExecutions).where(eq(decisionEffectExecutions.decisionId, created.id)))
      .toEqual([expect.objectContaining({ status: "failed", error: "deny_decision_signature" })]);
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });

  it("retries a terminal continuation after a crash between effects and wake delivery", async () => {
    const created = await createCommentDecision();
    const crashingService = decisionService(db, { wakeOriginAgent: async () => {
      throw new Error("simulated post-execution crash");
    } });

    await expect(crashingService.decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() }))
      .rejects.toThrow("simulated post-execution crash");
    expect((await service().get(created.id))?.executionStatus).toBe("succeeded");
    expect((await service().get(created.id))?.metadata).toMatchObject({ continuationPending: true });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);

    await service().sweepExpired();

    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
    expect((await service().get(created.id))?.metadata).toMatchObject({ continuationPending: false });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId))).toHaveLength(1);
  });

  it("delivers the continuation when the origin agent cancels a decision", async () => {
    const created = await createCommentDecision();

    const cancelled = await service().cancel(created.id, { actorType: "agent", actorId: agentId, runId });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.metadata).toMatchObject({ continuationPending: false });
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "cancelled" }]);
  });

  it("adds open decisions to the attention feed and badge count", async () => {
    const created = await createCommentDecision();
    const feed = await attentionService(db).list(companyId, { userId: decidedByUserId });
    expect(feed.countsBySourceKind.decision).toBe(1);
    expect(feed.items).toEqual(expect.arrayContaining([expect.objectContaining({
      sourceKind: "decision",
      subject: expect.objectContaining({ id: created.id, kind: "decision" }),
    })]));
  });

  it("batches effect executions into terminal decision lists", async () => {
    const created = await createCommentDecision();
    await service().decide({ id: created.id, optionId: "yes", decidedByUserId, userActor: boardActor() });

    const listed = await service().list(companyId, { status: "decided" });

    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({
      id: created.id,
      executions: [expect.objectContaining({ effectIndex: 0, status: "executed" })],
    })]));
  });

  it("bounds the open-decision slice of the attention feed", async () => {
    const older = await createCommentDecision("lenient", { idempotencyKey: "attention-older" });
    const newer = await createCommentDecision("lenient", { idempotencyKey: "attention-newer" });
    await db.update(decisions).set({ updatedAt: new Date(Date.now() - 1_000) }).where(eq(decisions.id, older.id));

    const feed = await attentionService(db, { openDecisionLimit: 1 }).list(companyId, { userId: decidedByUserId });

    expect(feed.countsBySourceKind.decision).toBe(1);
    expect(feed.items.filter((item) => item.sourceKind === "decision").map((item) => item.subject.id)).toEqual([newer.id]);
  });

  it("loads target staleness in a bounded query for the open-decision list", async () => {
    const first = await createCommentDecision("lenient", { idempotencyKey: "list-query-1" });
    const second = await createCommentDecision("lenient", { idempotencyKey: "list-query-2" });
    await db.update(issues).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(issues.id, targetIssueId));

    const selectSpy = vi.spyOn(db, "select");
    try {
      const listed = await service().list(companyId, { status: "open" });
      expect(selectSpy).toHaveBeenCalledTimes(2);
      expect(listed.filter((decision) => decision.id === first.id || decision.id === second.id))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: first.id, targetChanged: { [targetIssueId]: true } }),
          expect.objectContaining({ id: second.id, targetChanged: { [targetIssueId]: true } }),
        ]));
    } finally {
      selectSpy.mockRestore();
    }
  });

  it("bounds expiration work to the configured batch size", async () => {
    process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "1";
    const first = await createCommentDecision("lenient", { idempotencyKey: "batch-1", expiresAt: nearFutureExpiry() });
    const second = await createCommentDecision("lenient", { idempotencyKey: "batch-2", expiresAt: nearFutureExpiry() });
    await expireDecisionNow(first.id);
    await expireDecisionNow(second.id);
    expect((await service().sweepExpired()).expired).toBe(1);
    expect((await service().sweepExpired()).expired).toBe(1);
  });

  it("falls back to the default sweep batch size for invalid configuration", async () => {
    process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE = "not-a-number";
    const first = await createCommentDecision("lenient", { idempotencyKey: "invalid-batch-1", expiresAt: nearFutureExpiry() });
    const second = await createCommentDecision("lenient", { idempotencyKey: "invalid-batch-2", expiresAt: nearFutureExpiry() });
    await expireDecisionNow(first.id);
    await expireDecisionNow(second.id);

    await expect(service().sweepExpired()).resolves.toMatchObject({ expired: 2 });
  });

  it("expires TTL and target-gone decisions and wakes the origin agent", async () => {
    const ttl = await createCommentDecision("lenient", { expiresAt: nearFutureExpiry() });
    const gone = await createCommentDecision("strict", { idempotencyKey: "gone" });
    await db.update(decisions).set({ expiresAt: new Date(0) }).where(eq(decisions.id, ttl.id));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, targetIssueId));
    await expireDecisionNow(ttl.id);
    expect((await service().sweepExpired()).expired).toBe(2);
    const rows = await db.select().from(decisions);
    expect(rows.find((row) => row.id === ttl.id)?.metadata).toMatchObject({ expiredReason: "ttl" });
    expect(rows.find((row) => row.id === gone.id)?.metadata).toMatchObject({ expiredReason: "target_gone" });
    expect(wakes).toHaveLength(2);
  });

  it("expires strict decisions whose targets completed after they were proposed", async () => {
    const completed = await createCommentDecision("strict", { idempotencyKey: "target-completed" });
    const lenient = await createCommentDecision("lenient", { idempotencyKey: "lenient-survives" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));

    expect((await service().sweepExpired()).expired).toBe(1);

    expect((await service().get(completed.id))?.metadata).toMatchObject({ expiredReason: "target_completed" });
    expect((await service().get(lenient.id))?.status).toBe("open");
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: completed.id, outcome: "expired" }]);
  });

  it("keeps strict decisions that intentionally target an already-done issue", async () => {
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));
    const reopen = await createCommentDecision("strict", { idempotencyKey: "already-done" });

    expect((await service().sweepExpired()).expired).toBe(0);
    expect((await service().get(reopen.id))?.status).toBe("open");
  });

  it("expires when a strict secondary target completes after proposal", async () => {
    const blockerId = randomUUID();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, targetIssueId));
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Secondary blocker",
      status: "todo",
      priority: "medium",
      responsibleUserId: decidedByUserId,
    });
    const created = await service().create({
      companyId,
      actor: agentActor(),
      agentId,
      runId,
      title: "Create follow-up?",
      body: "Body",
      options: [{
        id: "yes",
        label: "Yes",
        effects: [{
          type: "create_issue",
          targetIssueId,
          staleness: "strict",
          draft: { title: "Follow-up", blockedByIssueIds: [blockerId] },
        }],
      }],
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));

    expect((await service().sweepExpired()).expired).toBe(1);
    expect((await service().get(created.id))?.metadata).toMatchObject({ expiredReason: "target_completed" });
  });

  it("groups rule-key stats and separates explicit dismissals from expiry", async () => {
    const accepted = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const rejected = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign another?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const acceptedAgain = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "routing.assign", title: "Assign again?", body: "Body",
      options: [{ id: "assign", label: "Assign", effects: [] }, { id: "skip", label: "Skip", effects: [] }],
    });
    const stale = await service().create({
      companyId, actor: agentActor(), agentId, runId, ruleKey: "cleanup.stale", title: "Clean up?", body: "Body",
      options: [{ id: "clean", label: "Clean", effects: [] }], expiresAt: nearFutureExpiry(),
    });
    await service().decide({ id: accepted.id, optionId: "assign", decidedByUserId, userActor: boardActor() });
    await service().decide({ id: acceptedAgain.id, optionId: "assign", decidedByUserId, userActor: boardActor() });
    await service().dismiss(rejected.id, decidedByUserId, boardActor(), "Not this time");
    await expireDecisionNow(stale.id);
    await service().sweepExpired();

    const stats = await service().stats(companyId, { originAgentId: agentId });
    expect(stats.filters).toEqual({ originAgentId: agentId, since: null });
    expect(stats.totals).toEqual({ proposed: 4, accepted: 2, rejected: 1, expired: 1 });
    expect(stats.groups).toEqual([
      { ruleKey: "cleanup.stale", proposed: 1, accepted: 0, rejected: 0, expired: 1, chosenOptions: [] },
      { ruleKey: "routing.assign", proposed: 3, accepted: 2, rejected: 1, expired: 0,
        chosenOptions: [{ optionId: "assign", count: 2 }] },
    ]);
    expect((await service().outcome(rejected.id)).metadata).toMatchObject({ dismissed: true, dismissReason: "Not this time" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed")))
      .toEqual([expect.objectContaining({ entityId: rejected.id, responsibleUserId: decidedByUserId })]);
  });

  it("rejects a legacy safe dismissal when the signed decision spec was tampered with", async () => {
    const created = await createCommentDecision();
    const legacySignature = signDecisionSpec({
      decisionId: created.id,
      options: created.options,
      targetSnapshots: created.targetSnapshots,
    });
    await db.update(decisions).set({
      authority: null,
      technicalEvidence: null,
      externalEnforcement: null,
      signedSpec: legacySignature,
    }).where(eq(decisions.id, created.id));
    await db.update(decisions).set({ options: [{ id: "tampered", label: "Tampered", effects: [{
      type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "tampered",
    }] }] }).where(eq(decisions.id, created.id));

    await expect(service().dismiss(created.id, decidedByUserId, boardActor(), "No"))
      .rejects.toThrow("Decision signature verification failed");
    expect((await service().get(created.id))?.status).toBe("open");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.dismissed"))).toHaveLength(0);
  });

  it("wakes the origin agent after a direct dismissal", async () => {
    const created = await createCommentDecision();
    const result = await service().dismiss(created.id, decidedByUserId, boardActor(), "No");

    expect(result).toMatchObject({ status: "decided", chosenOptionId: "dismissed" });
    expect(wakes).toEqual([{ companyId, agentId, issueId: originIssueId, decisionId: created.id, outcome: "decided" }]);
  });
});
