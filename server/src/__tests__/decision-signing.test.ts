import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signDecisionSpec, verifyDecisionSpec } from "../services/decision-signing.js";

const governanceSpec = () => ({
  decisionId: "11111111-1111-4111-8111-111111111111",
  authority: {
    schemaVersion: 1,
    authorityClass: "execution_authority",
    issuer: {
      userId: "user-1",
      source: { kind: "issue", id: "22222222-2222-4222-8222-222222222222" },
      issuedAt: "2026-08-11T12:00:00.000Z",
    },
    actor: { kind: "agent", id: "33333333-3333-4333-8333-333333333333" },
    targetIssueIds: ["44444444-4444-4444-8444-444444444444"],
    capabilities: ["delivery"],
    expiresAt: "2026-08-12T12:00:00.000Z",
    requiredExternalGates: ["required_checks", "exact_head"],
  },
  technicalEvidence: { repository: { id: "repo-1" }, pullRequest: { number: 42, headSha: "a".repeat(40) } },
  externalEnforcement: { repositoryId: "repo-1", pullRequestNumber: 42, actor: "user-1", allowed: true },
  options: [{ id: "ship", effects: [{ type: "update_issue_status", targetIssueId: "44444444-4444-4444-8444-444444444444", status: "done" }] }],
  inputs: null,
  targetSnapshots: { "44444444-4444-4444-8444-444444444444": { status: "in_progress" } },
});

describe("decision governance signing", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
  });

  it("covers authority and separate technical and enforcement evidence", () => {
    const spec = governanceSpec();
    const signature = signDecisionSpec(spec);
    expect(verifyDecisionSpec(spec, signature)).toBe(true);
  });

  it.each([
    ["issuer", (spec: ReturnType<typeof governanceSpec>) => { spec.authority.issuer.userId = "attacker"; }],
    ["capability", (spec: ReturnType<typeof governanceSpec>) => { spec.authority.capabilities = ["merge"]; }],
    ["technical evidence", (spec: ReturnType<typeof governanceSpec>) => { spec.technicalEvidence.pullRequest.headSha = "b".repeat(40); }],
    ["external enforcement", (spec: ReturnType<typeof governanceSpec>) => { spec.externalEnforcement.allowed = false; }],
  ])("rejects post-signature %s tampering", (_label, mutate) => {
    const spec = governanceSpec();
    const signature = signDecisionSpec(spec);
    mutate(spec);
    expect(verifyDecisionSpec(spec, signature)).toBe(false);
  });

  it("is stable across object key ordering but not array ordering", () => {
    const spec = governanceSpec();
    const reordered = { targetSnapshots: spec.targetSnapshots, inputs: spec.inputs, options: spec.options,
      externalEnforcement: spec.externalEnforcement, technicalEvidence: spec.technicalEvidence,
      authority: spec.authority, decisionId: spec.decisionId };
    expect(signDecisionSpec(reordered)).toBe(signDecisionSpec(spec));
    const reorderedTargets = governanceSpec();
    reorderedTargets.authority.requiredExternalGates.reverse();
    expect(signDecisionSpec(reorderedTargets)).not.toBe(signDecisionSpec(spec));
  });
});
