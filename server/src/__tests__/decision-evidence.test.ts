import { describe, expect, it, vi } from "vitest";
import type {
  DecisionTechnicalEvidenceV1,
  ExternalEnforcementEvidenceV1,
} from "@paperclipai/shared";
import {
  createGitHubDecisionEvidenceCapture,
  createGitHubDecisionEvidenceLoader,
  revalidateDecisionEvidence,
  type DecisionEvidenceSnapshot,
} from "../services/decision-evidence.js";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const fingerprint = (value: string) => `sha256:${value.repeat(64)}`;

function technicalEvidence(): DecisionTechnicalEvidenceV1 {
  return {
    schemaVersion: 1,
    provider: "github",
    repository: { id: "R_kgDOPaperclip", owner: "paperclipai", name: "paperclip" },
    pullRequest: {
      number: 321,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeCommitSha: null,
      mergedAt: null,
    },
    fingerprints: {
      environment: fingerprint("1"),
      configuration: fingerprint("2"),
      branchRules: fingerprint("3"),
    },
    observedAt: "2026-08-11T12:00:00.000Z",
    expiresAt: "2026-08-11T13:00:00.000Z",
    requiredChecks: [{ runId: "check-101", name: "test", appId: 42, conclusion: "success", commitSha: HEAD_SHA }],
    reviews: [{ id: "review-202", actor: "paperclip-maintainer", state: "approved", commitSha: HEAD_SHA, submittedAt: "2026-08-11T12:03:00.000Z" }],
  };
}

function externalEnforcement(): ExternalEnforcementEvidenceV1 {
  return {
    schemaVersion: 1,
    provider: "github",
    repositoryId: "R_kgDOPaperclip",
    pullRequestNumber: 321,
    actor: "paperclip-maintainer",
    headSha: HEAD_SHA,
    evaluatedAt: "2026-08-11T12:01:00.000Z",
    allowed: true,
    gates: [
      "github_actor",
      "codeowners_review",
      "branch_protection",
      "required_checks",
      "exact_head",
      "merge_gate",
    ].map((type) => ({
      type: type as ExternalEnforcementEvidenceV1["gates"][number]["type"],
      status: "passed" as const,
      evidenceIds: [`${type}:proof`],
    })),
  };
}

function expected(): DecisionEvidenceSnapshot {
  return { technicalEvidence: technicalEvidence(), externalEnforcement: externalEnforcement() };
}

const now = new Date("2026-08-11T12:05:00.000Z");

describe("decision evidence revalidation", () => {
  it("accepts a freshly re-resolved complete immutable envelope", async () => {
    const signed = expected();
    const result = await revalidateDecisionEvidence({
      companyId: "company-1",
      expectedTechnicalEvidence: signed.technicalEvidence,
      expectedExternalEnforcement: signed.externalEnforcement,
      load: async () => structuredClone(signed),
      now,
    });

    expect(result).toMatchObject({ ok: true, reason: null });
    expect(result.externalEnforcement).toEqual(signed.externalEnforcement);
  });

  it.each([
    ["head drift", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.pullRequest.headSha = "d".repeat(40); snapshot.technicalEvidence.requiredChecks[0]!.commitSha = "d".repeat(40); snapshot.technicalEvidence.reviews[0]!.commitSha = "d".repeat(40); }],
    ["base drift", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.pullRequest.baseSha = "d".repeat(40); }],
    ["branch-rule drift", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.fingerprints.branchRules = fingerprint("4"); }],
    ["environment drift", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.fingerprints.environment = fingerprint("4"); }],
    ["configuration drift", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.fingerprints.configuration = fingerprint("4"); }],
    ["check rerun", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.requiredChecks[0]!.runId = "check-999"; }],
    ["check failure", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.requiredChecks[0]!.conclusion = "failure"; }],
    ["review dismissal", (snapshot: DecisionEvidenceSnapshot) => { snapshot.technicalEvidence.reviews[0]!.state = "dismissed"; }],
    ["merge-state change", (snapshot: DecisionEvidenceSnapshot) => {
      snapshot.technicalEvidence.pullRequest.mergeCommitSha = MERGE_SHA;
      snapshot.technicalEvidence.pullRequest.mergedAt = "2026-08-11T12:02:00.000Z";
      snapshot.technicalEvidence.observedAt = "2026-08-11T12:03:00.000Z";
      snapshot.externalEnforcement.evaluatedAt = "2026-08-11T12:04:00.000Z";
    }],
  ])("blocks %s", async (_label, mutate) => {
    const signed = expected();
    const current = structuredClone(signed);
    mutate(current);
    const result = await revalidateDecisionEvidence({
      companyId: "company-1",
      expectedTechnicalEvidence: signed.technicalEvidence,
      expectedExternalEnforcement: signed.externalEnforcement,
      load: async () => current,
      now,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("evidence_drifted");
    expect(result.externalEnforcement.allowed).toBe(false);
  });

  it("blocks when the configured provider is unavailable", async () => {
    const signed = expected();
    const result = await revalidateDecisionEvidence({
      companyId: "company-1",
      expectedTechnicalEvidence: signed.technicalEvidence,
      expectedExternalEnforcement: signed.externalEnforcement,
      load: async () => { throw new Error("provider unavailable"); },
      now,
    });

    expect(result).toMatchObject({ ok: false, reason: "evidence_unavailable" });
    expect(result.externalEnforcement.allowed).toBe(false);
  });

  it("blocks expired technical evidence without consulting the provider", async () => {
    const signed = expected();
    signed.technicalEvidence.expiresAt = "2026-08-11T12:04:00.000Z";
    let loaded = false;
    const result = await revalidateDecisionEvidence({
      companyId: "company-1",
      expectedTechnicalEvidence: signed.technicalEvidence,
      expectedExternalEnforcement: signed.externalEnforcement,
      load: async () => { loaded = true; return signed; },
      now,
    });

    expect(result).toMatchObject({ ok: false, reason: "evidence_expired" });
    expect(loaded).toBe(false);
  });

  it("stores the provider's separate failed enforcement result", async () => {
    const signed = expected();
    const current = structuredClone(signed);
    current.externalEnforcement.allowed = false;
    current.externalEnforcement.gates.find((gate) => gate.type === "required_checks")!.status = "failed";
    const result = await revalidateDecisionEvidence({
      companyId: "company-1",
      expectedTechnicalEvidence: signed.technicalEvidence,
      expectedExternalEnforcement: signed.externalEnforcement,
      load: async () => current,
      now,
    });

    expect(result).toMatchObject({ ok: false, reason: "external_enforcement_denied" });
    expect(result.externalEnforcement).toEqual(current.externalEnforcement);
  });

  it("rejects an actor mismatch even when every reported gate passed", async () => {
    const signed = expected();
    const current = structuredClone(signed);
    current.externalEnforcement.actor = "different-actor";
    const result = await revalidateDecisionEvidence({
      companyId: "company-1",
      expectedTechnicalEvidence: signed.technicalEvidence,
      expectedExternalEnforcement: signed.externalEnforcement,
      load: async () => current,
      now,
    });

    expect(result).toMatchObject({ ok: false, reason: "external_enforcement_denied" });
    expect(result.externalEnforcement.allowed).toBe(false);
  });

  it("accepts an observation stamped after asynchronous provider resolution starts", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(now);
      const signed = expected();
      const current = structuredClone(signed);
      current.technicalEvidence.observedAt = "2026-08-11T12:05:00.010Z";
      current.externalEnforcement.evaluatedAt = "2026-08-11T12:05:00.010Z";

      const result = await revalidateDecisionEvidence({
        companyId: "company-1",
        expectedTechnicalEvidence: signed.technicalEvidence,
        expectedExternalEnforcement: signed.externalEnforcement,
        load: async () => {
          vi.setSystemTime(new Date("2026-08-11T12:05:00.010Z"));
          return current;
        },
      });

      expect(result).toMatchObject({ ok: true, reason: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects enforcement evaluated before the current technical observation", async () => {
    const signed = expected();
    const current = structuredClone(signed);
    current.externalEnforcement.evaluatedAt = "2026-08-11T11:59:59.000Z";
    const result = await revalidateDecisionEvidence({
      companyId: "company-1",
      expectedTechnicalEvidence: signed.technicalEvidence,
      expectedExternalEnforcement: signed.externalEnforcement,
      load: async () => current,
      now,
    });

    expect(result).toMatchObject({ ok: false, reason: "external_enforcement_denied" });
    expect(result.externalEnforcement.allowed).toBe(false);
  });
});

describe("production GitHub decision evidence loader", () => {
  function githubResponse(url: string) {
    if (url.endsWith("/graphql")) return {
      data: { repository: { pullRequest: { reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" } } },
    };
    if (url.endsWith("/pulls/321")) return {
      state: "open",
      draft: false,
      mergeable: true,
      mergeable_state: "clean",
      rebaseable: true,
      maintainer_can_modify: true,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      base: {
        ref: "master",
        sha: BASE_SHA,
        repo: { node_id: "R_kgDOPaperclip" },
      },
      head: { ref: "codex/governance", sha: HEAD_SHA },
    };
    if (url.includes("/check-runs")) return {
      check_runs: [{ id: 101, name: "test", conclusion: "success", app: { id: 42 } }],
    };
    if (url.includes("/commits/") && url.includes("/status")) return { statuses: [] };
    if (url.includes("/reviews")) return [{
      id: 202,
      state: "APPROVED",
      commit_id: HEAD_SHA,
      submitted_at: "2026-08-11T12:03:00.000Z",
      user: { login: "paperclip-maintainer" },
    }];
    if (url.includes("/branches/master/protection")) return {
      required_status_checks: { strict: true, contexts: [], checks: [{ context: "test", app_id: 42 }] },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: 1,
        require_last_push_approval: false,
      },
      restrictions: null,
      enforce_admins: { enabled: true },
      required_linear_history: { enabled: false },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    };
    if (url.includes("/deployments?")) return [];
    if (url.endsWith("/repos/paperclipai/paperclip")) return {
      node_id: "R_kgDOPaperclip",
      archived: false,
      disabled: false,
      visibility: "public",
      allow_auto_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      allow_squash_merge: true,
      delete_branch_on_merge: true,
      web_commit_signoff_required: false,
    };
    if (url.endsWith("/user")) return { login: "paperclip-maintainer" };
    throw new Error(`Unexpected GitHub URL: ${url}`);
  }

  function loader(
    actor = "paperclip-maintainer",
    responseFor = githubResponse,
  ) {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer github-token");
      return new Response(JSON.stringify(responseFor(url)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const signed = expected();
    signed.externalEnforcement.actor = actor;
    return {
      fetch,
      signed,
      load: createGitHubDecisionEvidenceLoader({} as never, {
        fetch,
        tokenProvider: "github-token",
        now: () => now,
      }),
    };
  }

  it("recomputes the complete exact-head envelope and all six external gates", async () => {
    const { fetch, signed, load } = loader();
    const snapshot = await load("company-1", signed);

    expect(fetch).toHaveBeenCalledTimes(9);
    expect(snapshot.technicalEvidence).toMatchObject({
      repository: { id: "R_kgDOPaperclip", owner: "paperclipai", name: "paperclip" },
      pullRequest: { number: 321, baseSha: BASE_SHA, headSha: HEAD_SHA },
      requiredChecks: [{ runId: "check:101", name: "test", appId: 42, conclusion: "success", commitSha: HEAD_SHA }],
      reviews: [{ id: "202", actor: "paperclip-maintainer", state: "approved", commitSha: HEAD_SHA, submittedAt: "2026-08-11T12:03:00.000Z" }],
    });
    expect(Object.values(snapshot.technicalEvidence.fingerprints)).toEqual([
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    ]);
    expect(snapshot.externalEnforcement.allowed).toBe(true);
    expect(snapshot.externalEnforcement.gates).toHaveLength(6);
    expect(snapshot.externalEnforcement.gates.every((gate) => gate.status === "passed")).toBe(true);
  });

  it("captures a complete provider-derived envelope for decision creation", async () => {
    const { fetch } = loader();
    const capture = createGitHubDecisionEvidenceCapture({} as never, {
      fetch,
      tokenProvider: "github-token",
      now: () => now,
    });

    const snapshot = await capture("company-1", {
      repository: { owner: "paperclipai", name: "paperclip" },
      pullRequestNumber: 321,
      actor: "paperclip-maintainer",
      expiresAt: "2026-08-11T13:00:00.000Z",
    });

    expect(fetch).toHaveBeenCalledTimes(9);
    expect(snapshot).toMatchObject({
      technicalEvidence: {
        pullRequest: { number: 321, headSha: HEAD_SHA },
        requiredChecks: [{ name: "test", appId: 42, conclusion: "success" }],
      },
      externalEnforcement: { actor: "paperclip-maintainer", headSha: HEAD_SHA, allowed: true },
    });
  });

  it("keeps the provider actor result separate and denies a mismatched signed actor", async () => {
    const { signed, load } = loader("different-actor");
    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement).toMatchObject({ actor: "paperclip-maintainer", allowed: false });
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "github_actor")?.status).toBe("failed");
  });

  it("does not let a same-name check from the wrong GitHub App satisfy an app-bound requirement", async () => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/check-runs")) {
        return { check_runs: [{ id: 101, name: "test", conclusion: "success", app: { id: 99 } }] };
      }
      return body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement.allowed).toBe(false);
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "required_checks")?.status).toBe("failed");
  });

  it("requires legacy contexts in addition to app-bound checks from a mixed branch rule", async () => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/branches/master/protection")) {
        const protection = structuredClone(body) as Record<string, any>;
        protection.required_status_checks.contexts = ["test", "legacy-status"];
        return protection;
      }
      return body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "required_checks")?.status).toBe("failed");
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "merge_gate")?.status).toBe("failed");
  });

  it("treats GitHub app_id -1 as an unbound any-app requirement", async () => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/branches/master/protection")) {
        const protection = structuredClone(body) as Record<string, any>;
        protection.required_status_checks.checks[0].app_id = -1;
        return protection;
      }
      return body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement.allowed).toBe(true);
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "required_checks")?.status).toBe("passed");
  });

  it("rejects a required check that omits its GitHub App binding", async () => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/branches/master/protection")) {
        const protection = structuredClone(body) as Record<string, any>;
        delete protection.required_status_checks.checks[0].app_id;
        return protection;
      }
      return body;
    });

    await expect(load("company-1", signed)).rejects.toThrow("required-check evidence was incomplete");
  });

  it.each([
    ["empty branch protection", (url: string, body: unknown) => url.includes("/branches/master/protection") ? {} : body],
    ["missing check-runs array", (url: string, body: unknown) => url.includes("/check-runs") ? {} : body],
    ["missing statuses array", (url: string, body: unknown) => url.includes("/commits/") && url.includes("/status") ? {} : body],
  ])("fails closed on %s provider payloads", async (_label, mutate) => {
    const { signed, load } = loader("paperclip-maintainer", (url) => mutate(url, githubResponse(url)));
    await expect(load("company-1", signed)).rejects.toThrow();
  });

  it("uses only the latest case-insensitive commit status for each required context", async () => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/check-runs")) return { check_runs: [] };
      if (url.includes("/commits/") && url.includes("/status")) return {
        statuses: [
          { id: 1, context: "TEST", state: "success", updated_at: "2026-08-11T11:00:00.000Z" },
          { id: 2, context: "test", state: "failure", updated_at: "2026-08-11T12:00:00.000Z" },
        ],
      };
      if (url.includes("/branches/master/protection")) {
        const protection = structuredClone(body) as Record<string, any>;
        protection.required_status_checks = { strict: true, contexts: ["Test"], checks: [] };
        return protection;
      }
      return body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.technicalEvidence.requiredChecks).toEqual([
      expect.objectContaining({ runId: "status:2", name: "test", conclusion: "failure" }),
    ]);
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "required_checks")?.status).toBe("failed");
  });

  it("keeps historical reviews while authorizing only the latest exact-head approval", async () => {
    const oldHead = "d".repeat(40);
    const mixed = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/reviews")) return [
        { id: 201, state: "APPROVED", commit_id: oldHead, submitted_at: "2026-08-11T11:00:00.000Z", user: { login: "paperclip-maintainer" } },
        ...(body as Array<Record<string, unknown>>),
      ];
      return body;
    });
    const mixedSnapshot = await mixed.load("company-1", mixed.signed);
    expect(mixedSnapshot.technicalEvidence.reviews).toHaveLength(2);
    expect(mixedSnapshot.externalEnforcement.gates.find((gate) => gate.type === "codeowners_review")?.status).toBe("passed");

    const oldOnly = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      return url.includes("/reviews")
        ? [{ id: 201, state: "APPROVED", commit_id: oldHead, submitted_at: "2026-08-11T11:00:00.000Z", user: { login: "paperclip-maintainer" } }]
        : body;
    });
    const oldSnapshot = await oldOnly.load("company-1", oldOnly.signed);
    expect(oldSnapshot.technicalEvidence.reviews).toHaveLength(1);
    expect(oldSnapshot.externalEnforcement.gates.find((gate) => gate.type === "codeowners_review")?.status).toBe("failed");
  });

  it.each(["unknown", "unstable", "behind"])("fails closed while GitHub mergeability is %s", async (mergeableState) => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      return url.endsWith("/pulls/321") ? { ...body, mergeable_state: mergeableState } : body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement.allowed).toBe(false);
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "codeowners_review")?.status).toBe("failed");
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "merge_gate")?.status).toBe("failed");
  });

  it("enforces the branch rule's required approval count", async () => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/branches/master/protection")) {
        const protection = structuredClone(body) as Record<string, any>;
        protection.required_pull_request_reviews.required_approving_review_count = 2;
        return protection;
      }
      return body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement.allowed).toBe(false);
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "codeowners_review")?.status).toBe("failed");
  });

  it("requires GitHub's direct review-policy aggregate for CODEOWNERS and last-push rules", async () => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.includes("/branches/master/protection")) {
        const protection = structuredClone(body) as Record<string, any>;
        protection.required_pull_request_reviews.require_last_push_approval = true;
        return protection;
      }
      return body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement.allowed).toBe(true);
    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "codeowners_review")?.status).toBe("passed");
  });

  it.each([
    ["partial GraphQL errors", [{ message: "partial review-policy result" }]],
    ["malformed GraphQL errors", { message: "not an array" }],
  ])("fails closed on %s even when partial data says APPROVED and CLEAN", async (_label, errors) => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      return url.endsWith("/graphql") ? { ...body, errors } : body;
    });

    await expect(load("company-1", signed)).rejects.toThrow("GraphQL errors");
  });

  it.each([
    ["non-CODEOWNER approval", false],
    ["the last pusher as the sole approver", true],
  ])("fails closed for clean mergeability with %s when GitHub review policy is not approved", async (_label, requireLastPushApproval) => {
    const { signed, load } = loader("paperclip-maintainer", (url) => {
      const body = githubResponse(url);
      if (url.endsWith("/graphql")) {
        return { data: { repository: { pullRequest: { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "CLEAN" } } } };
      }
      if (requireLastPushApproval && url.includes("/branches/master/protection")) {
        const protection = structuredClone(body) as Record<string, any>;
        protection.required_pull_request_reviews.require_last_push_approval = true;
        return protection;
      }
      return body;
    });

    const snapshot = await load("company-1", signed);

    expect(snapshot.externalEnforcement.gates.find((gate) => gate.type === "codeowners_review")?.status).toBe("failed");
    expect(snapshot.externalEnforcement.allowed).toBe(false);
  });

  it("fails closed before network access when no configured GitHub credential exists", async () => {
    const fetch = vi.fn();
    const load = createGitHubDecisionEvidenceLoader({} as never, { fetch, tokenProvider: null });

    await expect(load("company-1", expected())).rejects.toThrow("credentials are unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
