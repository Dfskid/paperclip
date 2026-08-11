import { describe, expect, it } from "vitest";
import {
  decisionAuthorityGrantSchema,
  decisionEffectSchema,
  decisionInputsSchema,
  decisionOptionSchema,
  decisionOptionsSchema,
  decisionSpecSchema,
  decisionTechnicalEvidenceSchema,
  externalEnforcementEvidenceSchema,
} from "./validators/decision.js";

const targetIssueId = "11111111-1111-4111-8111-111111111111";
const secondIssueId = "22222222-2222-4222-8222-222222222222";
const issuerUserId = "local-board";
const originAgentId = "33333333-3333-4333-8333-333333333333";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);

const designAuthority = {
  schemaVersion: 1,
  authorityClass: "design_approval",
  issuer: {
    userId: issuerUserId,
    source: { kind: "issue", id: targetIssueId },
    issuedAt: "2026-08-10T12:00:00.000Z",
  },
  actor: { kind: "agent", id: originAgentId },
  targetIssueIds: [targetIssueId, secondIssueId],
  capabilities: [],
  expiresAt: "2026-08-11T12:00:00.000Z",
  requiredExternalGates: [],
} as const;

const executionAuthority = {
  ...designAuthority,
  authorityClass: "execution_authority",
  capabilities: ["implementation", "delivery"],
} as const;

const technicalEvidence = {
  schemaVersion: 1,
  provider: "github",
  repository: { id: "R_kgDOExample", owner: "paperclipai", name: "paperclip" },
  pullRequest: {
    number: 123,
    baseSha,
    headSha,
    mergeCommitSha: mergeSha,
    mergedAt: "2026-08-10T11:58:00.000Z",
  },
  fingerprints: {
    environment: `sha256:${"d".repeat(64)}`,
    configuration: `sha256:${"e".repeat(64)}`,
    branchRules: `sha256:${"f".repeat(64)}`,
  },
  observedAt: "2026-08-10T12:00:00.000Z",
  expiresAt: "2026-08-10T12:10:00.000Z",
  requiredChecks: [{
    runId: "987654321",
    name: "test",
    appId: 42,
    conclusion: "success",
    commitSha: headSha,
  }],
  reviews: [{
    id: "PRR_kwDOExample",
    actor: "independent-reviewer",
    state: "approved",
    commitSha: headSha,
    submittedAt: "2026-08-10T11:59:00.000Z",
  }],
} as const;

const externalEnforcement = {
  schemaVersion: 1,
  provider: "github",
  repositoryId: "R_kgDOExample",
  pullRequestNumber: 123,
  actor: "paperclip-delivery-bot",
  headSha,
  evaluatedAt: "2026-08-10T12:00:00.000Z",
  allowed: true,
  gates: [
    { type: "github_actor", status: "passed", evidenceIds: ["paperclip-delivery-bot"] },
    { type: "codeowners_review", status: "passed", evidenceIds: ["PRR_kwDOExample"] },
    { type: "branch_protection", status: "passed", evidenceIds: ["ruleset-42"] },
    { type: "required_checks", status: "passed", evidenceIds: ["987654321"] },
    { type: "exact_head", status: "passed", evidenceIds: [headSha] },
    { type: "merge_gate", status: "passed", evidenceIds: [mergeSha] },
  ],
} as const;

describe("decision validators", () => {
  it("accepts explicit design and bounded execution authority", () => {
    expect(decisionAuthorityGrantSchema.parse(designAuthority)).toEqual(designAuthority);
    expect(decisionAuthorityGrantSchema.parse(executionAuthority)).toEqual(executionAuthority);
  });

  it("allows design approval only for comments and separately blocked unassigned tasks", () => {
    const valid = decisionSpecSchema.parse({
      authority: designAuthority,
      options: [{
        id: "accept",
        label: "Accept design",
        effects: [
          { type: "comment_on_issue", targetIssueId, staleness: "lenient", bodyMarkdown: "Design accepted" },
          {
            type: "create_issue",
            targetIssueId,
            staleness: "strict",
            draft: { title: "Implement accepted design", blockedByIssueIds: [secondIssueId] },
          },
        ],
      }],
    });
    expect(valid.authority.authorityClass).toBe("design_approval");

    for (const forbiddenEffect of [
      { type: "create_issue", targetIssueId, staleness: "strict", draft: { title: "Start now" } },
      { type: "assign_issue", targetIssueId, staleness: "strict", assigneeAgentId: originAgentId },
      { type: "update_issue_status", targetIssueId, staleness: "strict", status: "done" },
      { type: "resolve_blocker", targetIssueId, staleness: "strict", removeBlockedByIssueIds: [secondIssueId] },
    ]) {
      expect(() => decisionSpecSchema.parse({
        authority: designAuthority,
        options: [{ id: "accept", label: "Accept", effects: [forbiddenEffect] }],
      })).toThrow();
    }
  });

  it("requires execution capabilities and targets to cover every effect", () => {
    expect(() => decisionSpecSchema.parse({
      authority: { ...executionAuthority, capabilities: ["implementation"] },
      options: [{
        id: "ship",
        label: "Ship",
        effects: [{ type: "update_issue_status", targetIssueId, staleness: "strict", status: "done" }],
      }],
    })).toThrow();
    expect(() => decisionSpecSchema.parse({
      authority: { ...executionAuthority, targetIssueIds: [targetIssueId] },
      options: [{
        id: "unblock",
        label: "Unblock",
        effects: [{ type: "resolve_blocker", targetIssueId, staleness: "strict", removeBlockedByIssueIds: [secondIssueId] }],
      }],
    })).toThrow();
  });

  it("defaults unknown authority, capability, and contract fields to denied", () => {
    expect(() => decisionAuthorityGrantSchema.parse({ ...designAuthority, authorityClass: "advisory" })).toThrow();
    expect(() => decisionAuthorityGrantSchema.parse({ ...executionAuthority, capabilities: ["root"] })).toThrow();
    expect(() => decisionAuthorityGrantSchema.parse({ ...designAuthority, ambientAuthority: true })).toThrow();
  });

  it("accepts a complete immutable GitHub evidence envelope and separate enforcement result", () => {
    expect(() => decisionSpecSchema.parse({
      authority: {
        ...executionAuthority,
        capabilities: ["merge"],
        requiredExternalGates: [],
      },
      options: [{ id: "record", label: "Record", effects: [] }],
    })).toThrow("Merge and deploy authority require provider-captured evidence and all GitHub gates");

    expect(decisionTechnicalEvidenceSchema.parse(technicalEvidence)).toEqual(technicalEvidence);
    expect(externalEnforcementEvidenceSchema.parse(externalEnforcement)).toEqual(externalEnforcement);
    expect(decisionSpecSchema.parse({
      authority: {
        ...executionAuthority,
        capabilities: ["merge"],
        requiredExternalGates: externalEnforcement.gates.map((gate) => gate.type),
      },
      technicalEvidence,
      externalEnforcement,
      options: [{ id: "record", label: "Record", effects: [] }],
    }).technicalEvidence?.pullRequest.headSha).toBe(headSha);
  });

  it("rejects incomplete, ambiguous, duplicate, stale, or extensible technical evidence", () => {
    expect(() => decisionTechnicalEvidenceSchema.parse({
      ...technicalEvidence,
      pullRequest: { ...technicalEvidence.pullRequest, headSha: headSha.slice(0, 12) },
    })).toThrow();
    expect(() => decisionTechnicalEvidenceSchema.parse({
      ...technicalEvidence,
      requiredChecks: [technicalEvidence.requiredChecks[0], technicalEvidence.requiredChecks[0]],
    })).toThrow();
    expect(() => decisionTechnicalEvidenceSchema.parse({
      ...technicalEvidence,
      observedAt: technicalEvidence.expiresAt,
      expiresAt: technicalEvidence.observedAt,
    })).toThrow();
    expect(() => decisionTechnicalEvidenceSchema.parse({ ...technicalEvidence, provider: "local_git" })).toThrow();
    expect(() => decisionTechnicalEvidenceSchema.parse({ ...technicalEvidence, proseApproval: "looks good" })).toThrow();
    expect(() => decisionTechnicalEvidenceSchema.parse({
      ...technicalEvidence,
      pullRequest: { ...technicalEvidence.pullRequest, mergeCommitSha: null },
    })).toThrow();
  });

  it("rejects an enforcement result that omits required external gates or contradicts allowed", () => {
    expect(() => externalEnforcementEvidenceSchema.parse({
      ...externalEnforcement,
      gates: externalEnforcement.gates.slice(1),
    })).toThrow();
    expect(() => externalEnforcementEvidenceSchema.parse({
      ...externalEnforcement,
      gates: externalEnforcement.gates.map((gate) => gate.type === "required_checks" ? { ...gate, status: "failed" } : gate),
    })).toThrow();
  });

  it("accepts all six effect variants", () => {
    const effects = [
      {
        type: "comment_on_issue",
        targetIssueId,
        staleness: "lenient",
        bodyMarkdown: "Approved with {{input.note}}",
      },
      {
        type: "create_issue",
        targetIssueId,
        staleness: "strict",
        draft: { title: "Follow up", parentId: targetIssueId },
      },
      {
        type: "update_issue_status",
        targetIssueId,
        staleness: "strict",
        status: "done",
        comment: "Decision approved",
      },
      {
        type: "assign_issue",
        targetIssueId,
        staleness: "lenient",
        assigneeAgentId: secondIssueId,
      },
      {
        type: "cancel_issue_tree",
        targetIssueId,
        staleness: "strict",
        reasonComment: "No longer needed",
      },
      {
        type: "resolve_blocker",
        targetIssueId,
        staleness: "strict",
        removeBlockedByIssueIds: [secondIssueId],
      },
    ];

    for (const effect of effects) {
      expect(decisionEffectSchema.parse(effect)).toEqual(effect);
    }
  });

  it("rejects malformed and unknown effects", () => {
    expect(() => decisionEffectSchema.parse({
      type: "comment_on_issue",
      targetIssueId,
      staleness: "strict",
    })).toThrow();
    expect(() => decisionEffectSchema.parse({
      type: "delete_company",
      targetIssueId,
      staleness: "strict",
    })).toThrow();
    expect(() => decisionEffectSchema.parse({
      type: "assign_issue",
      targetIssueId,
      staleness: "strict",
    })).toThrow();
  });

  it("forces cancel-tree effects to be strict and destructive", () => {
    expect(() => decisionEffectSchema.parse({
      type: "cancel_issue_tree",
      targetIssueId,
      staleness: "lenient",
      reasonComment: "No longer needed",
    })).toThrow();

    expect(() => decisionOptionSchema.parse({
      id: "cancel",
      label: "Cancel tree",
      effects: [{
        type: "cancel_issue_tree",
        targetIssueId,
        staleness: "strict",
        reasonComment: "No longer needed",
      }],
    })).toThrow();

    expect(decisionOptionSchema.parse({
      id: "cancel",
      label: "Cancel tree",
      style: "destructive",
      effects: [{
        type: "cancel_issue_tree",
        targetIssueId,
        staleness: "strict",
        reasonComment: "No longer needed",
      }],
    }).style).toBe("destructive");
  });

  it("enforces option, input, and effect limits", () => {
    const dismissOption = { id: "dismiss", label: "Dismiss", effects: [] };
    expect(decisionOptionsSchema.parse(Array.from({ length: 8 }, (_, index) => ({
      ...dismissOption,
      id: `option-${index}`,
    })))).toHaveLength(8);
    expect(() => decisionOptionsSchema.parse(Array.from({ length: 9 }, (_, index) => ({
      ...dismissOption,
      id: `option-${index}`,
    })))).toThrow();

    expect(decisionInputsSchema.parse(Array.from({ length: 4 }, (_, index) => ({
      id: `input-${index}`,
      label: `Input ${index}`,
    })))).toHaveLength(4);
    expect(() => decisionInputsSchema.parse(Array.from({ length: 5 }, (_, index) => ({
      id: `input-${index}`,
      label: `Input ${index}`,
    })))).toThrow();

    const commentEffect = {
      type: "comment_on_issue",
      targetIssueId,
      staleness: "strict",
      bodyMarkdown: "Comment",
    };
    expect(decisionOptionSchema.parse({
      id: "approve",
      label: "Approve",
      effects: Array.from({ length: 10 }, () => commentEffect),
    }).effects).toHaveLength(10);
    expect(() => decisionOptionSchema.parse({
      id: "approve",
      label: "Approve",
      effects: Array.from({ length: 11 }, () => commentEffect),
    })).toThrow();
  });

  it("rejects duplicate option and input ids", () => {
    expect(() => decisionOptionsSchema.parse([
      { id: "same", label: "One", effects: [] },
      { id: "same", label: "Two", effects: [] },
    ])).toThrow();
    expect(() => decisionInputsSchema.parse([
      { id: "same", label: "One" },
      { id: "same", label: "Two" },
    ])).toThrow();
  });
});
